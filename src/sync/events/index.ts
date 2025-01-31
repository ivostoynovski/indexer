import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { Log } from "@ethersproject/abstract-provider";
import { AddressZero, HashZero } from "@ethersproject/constants";
import { keccak256 } from "@ethersproject/solidity";
import * as Sdk from "@reservoir0x/sdk";
import _ from "lodash";
import pLimit from "p-limit";

import { logger } from "@/common/logger";
import { idb, pgp, redb } from "@/common/db";
import { baseProvider } from "@/common/provider";
import { bn, fromBuffer, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { getNetworkSettings } from "@/config/network";
import { EventDataKind, getEventData } from "@/events-sync/data";
import * as es from "@/events-sync/storage";
import * as syncEventsUtils from "@/events-sync/utils";
import { BaseEventParams, parseEvent } from "@/events-sync/parser";
import * as blockCheck from "@/jobs/events-sync/block-check-queue";
import * as fillUpdates from "@/jobs/fill-updates/queue";
import * as orderUpdatesById from "@/jobs/order-updates/by-id-queue";
import * as orderUpdatesByMaker from "@/jobs/order-updates/by-maker-queue";
import * as orderbookOrders from "@/jobs/orderbook/orders-queue";
import * as tokenUpdatesMint from "@/jobs/token-updates/mint-queue";
import * as processActivityEvent from "@/jobs/activities/process-activity-event";
import * as removeUnsyncedEventsActivities from "@/jobs/activities/remove-unsynced-events-activities";
import * as blocksModel from "@/models/blocks";
import { OrderKind, getOrderSourceByOrderKind } from "@/orderbook/orders";
import * as Foundation from "@/orderbook/orders/foundation";
import { getUSDAndNativePrices } from "@/utils/prices";

// TODO: Split into multiple files (by exchange)
// TODO: For simplicity, don't use bulk inserts/upserts for realtime
// processing (this will make things so much more flexible). However
// for backfill procesing, we should still use bulk operations so as
// to be performant enough. This might imply separate code to handle
// backfill vs realtime events.

// Cache the network settings
const NS = getNetworkSettings();

export const syncEvents = async (
  fromBlock: number,
  toBlock: number,
  options?: {
    backfill?: boolean;
    skipNonFillWrites?: boolean;
    eventDataKinds?: EventDataKind[];
  }
) => {
  // --- Handle: fetch and process events ---

  // Cache blocks for efficiency
  const blocksCache = new Map<number, blocksModel.Block>();
  // Keep track of all handled `${block}-${blockHash}` pairs
  const blocksSet = new Set<string>();

  // Keep track of data needed by other processes that will get triggered
  const fillInfos: fillUpdates.FillInfo[] = [];
  const orderInfos: orderUpdatesById.OrderInfo[] = [];
  const makerInfos: orderUpdatesByMaker.MakerInfo[] = [];
  const mintInfos: tokenUpdatesMint.MintInfo[] = [];

  const cryptopunksTransferEvents: {
    to: string;
    txHash: string;
  }[] = [];

  // For handling mints as sales
  const tokensMinted = new Map<
    string,
    {
      contract: string;
      from: string;
      tokenId: string;
      amount: string;
      baseEventParams: BaseEventParams;
    }[]
  >();

  // Before proceeding, fetch all individual blocks within the current range
  const limit = pLimit(5);
  await Promise.all(
    _.range(fromBlock, toBlock + 1).map((block) =>
      limit(() => baseProvider.getBlockWithTransactions(block))
    )
  );

  // When backfilling, certain processes are disabled
  const backfill = Boolean(options?.backfill);
  const eventDatas = getEventData(options?.eventDataKinds);
  await baseProvider
    .getLogs({
      // Only keep unique topics (eg. an example of duplicated topics are
      // erc721 and erc20 transfers which have the exact same signature)
      topics: [[...new Set(eventDatas.map(({ topic }) => topic))]],
      fromBlock,
      toBlock,
    })
    .then(async (logs) => {
      const ftTransferEvents: es.ftTransfers.Event[] = [];
      const nftApprovalEvents: es.nftApprovals.Event[] = [];
      const nftTransferEvents: es.nftTransfers.Event[] = [];
      const bulkCancelEvents: es.bulkCancels.Event[] = [];
      const nonceCancelEvents: es.nonceCancels.Event[] = [];
      const cancelEvents: es.cancels.Event[] = [];
      const cancelEventsFoundation: es.cancels.Event[] = [];
      const fillEvents: es.fills.Event[] = [];
      const fillEventsPartial: es.fills.Event[] = [];
      const fillEventsFoundation: es.fills.Event[] = [];
      const foundationOrders: Foundation.OrderInfo[] = [];

      // Keep track of all events within the currently processing transaction
      let currentTx: string | undefined;
      let currentTxEvents: {
        log: Log;
        address: string;
        logIndex: number;
      }[] = [];

      const currentTxHasWethTransfer = () => {
        for (const event of currentTxEvents.slice(0, -1).reverse()) {
          const erc20EventData = getEventData(["erc20-transfer"])[0];
          if (
            event.log.topics[0] === erc20EventData.topic &&
            event.log.topics.length === erc20EventData.numTopics &&
            erc20EventData.addresses?.[event.log.address.toLowerCase()]
          ) {
            return true;
          }
        }
        return false;
      };

      for (const log of logs) {
        try {
          const baseEventParams = await parseEvent(log, blocksCache);
          blocksSet.add(`${log.blockNumber}-${log.blockHash}`);

          // It's quite important from a performance perspective to have
          // the block data available before proceeding with the events
          if (!blocksCache.has(baseEventParams.block)) {
            blocksCache.set(
              baseEventParams.block,
              await blocksModel.saveBlock({
                number: baseEventParams.block,
                hash: baseEventParams.blockHash,
                timestamp: baseEventParams.timestamp,
              })
            );
          }

          // Save the event in the currently processing transaction data
          if (currentTx !== baseEventParams.txHash) {
            currentTx = baseEventParams.txHash;
            currentTxEvents = [];
          }
          currentTxEvents.push({
            log,
            address: baseEventParams.address,
            logIndex: baseEventParams.logIndex,
          });

          // Find first matching event:
          // - matching topic
          // - matching number of topics (eg. indexed fields)
          // - matching addresses
          const eventData = eventDatas.find(
            ({ addresses, topic, numTopics }) =>
              log.topics[0] === topic &&
              log.topics.length === numTopics &&
              (addresses ? addresses[log.address.toLowerCase()] : true)
          );

          switch (eventData?.kind) {
            // Erc721

            case "erc721-transfer": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();

              nftTransferEvents.push({
                kind: "erc721",
                from,
                to,
                tokenId,
                amount: "1",
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${tokenId}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-sell-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });
              makerInfos.push({
                context: `${contextPrefix}-${to}-sell-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });

              if (from === AddressZero) {
                mintInfos.push({
                  contract: baseEventParams.address,
                  tokenId,
                  mintedTimestamp: baseEventParams.timestamp,
                });

                // Treat mints as sales
                if (!NS.mintsAsSalesBlacklist.includes(baseEventParams.address)) {
                  if (!tokensMinted.has(baseEventParams.txHash)) {
                    tokensMinted.set(baseEventParams.txHash, []);
                  }
                  tokensMinted.get(baseEventParams.txHash)!.push({
                    contract: baseEventParams.address,
                    tokenId,
                    from,
                    amount: "1",
                    baseEventParams,
                  });
                }
              }

              break;
            }

            // Erc1155

            case "erc1155-transfer-single": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();
              const amount = parsedLog.args["amount"].toString();

              nftTransferEvents.push({
                kind: "erc1155",
                from,
                to,
                tokenId,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${tokenId}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-sell-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });
              makerInfos.push({
                context: `${contextPrefix}-${to}-sell-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });

              if (from === AddressZero) {
                mintInfos.push({
                  contract: baseEventParams.address,
                  tokenId,
                  mintedTimestamp: baseEventParams.timestamp,
                });

                // Treat mints as sales
                if (!NS.mintsAsSalesBlacklist.includes(baseEventParams.address)) {
                  if (!tokensMinted.has(baseEventParams.txHash)) {
                    tokensMinted.set(baseEventParams.txHash, []);
                  }
                  tokensMinted.get(baseEventParams.txHash)!.push({
                    contract: baseEventParams.address,
                    tokenId,
                    from,
                    amount,
                    baseEventParams,
                  });
                }
              }

              break;
            }

            case "erc1155-transfer-batch": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const tokenIds = parsedLog.args["tokenIds"].map(String);
              const amounts = parsedLog.args["amounts"].map(String);

              const count = Math.min(tokenIds.length, amounts.length);
              for (let i = 0; i < count; i++) {
                nftTransferEvents.push({
                  kind: "erc1155",
                  from,
                  to,
                  tokenId: tokenIds[i],
                  amount: amounts[i],
                  baseEventParams: {
                    ...baseEventParams,
                    batchIndex: i + 1,
                  },
                });

                // Make sure to only handle the same data once per transaction
                const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${tokenIds[i]}`;

                makerInfos.push({
                  context: `${contextPrefix}-${from}-sell-balance`,
                  maker: from,
                  trigger: {
                    kind: "balance-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "sell-balance",
                    contract: baseEventParams.address,
                    tokenId: tokenIds[i],
                  },
                });
                makerInfos.push({
                  context: `${contextPrefix}-${to}-sell-balance`,
                  maker: to,
                  trigger: {
                    kind: "balance-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "sell-balance",
                    contract: baseEventParams.address,
                    tokenId: tokenIds[i],
                  },
                });

                if (from === AddressZero) {
                  mintInfos.push({
                    contract: baseEventParams.address,
                    tokenId: tokenIds[i],
                    mintedTimestamp: baseEventParams.timestamp,
                  });

                  // Treat mints as sales
                  if (!NS.mintsAsSalesBlacklist.includes(baseEventParams.address)) {
                    if (!tokensMinted.has(baseEventParams.txHash)) {
                      tokensMinted.set(baseEventParams.txHash, []);
                    }
                    tokensMinted.get(baseEventParams.txHash)!.push({
                      contract: baseEventParams.address,
                      tokenId: tokenIds[i],
                      amount: amounts[i],
                      from,
                      baseEventParams,
                    });
                  }
                }
              }

              break;
            }

            // Erc721/Erc1155 common

            case "erc721/1155-approval-for-all": {
              const parsedLog = eventData.abi.parseLog(log);
              const owner = parsedLog.args["owner"].toLowerCase();
              const operator = parsedLog.args["operator"].toLowerCase();
              const approved = parsedLog.args["approved"];

              nftApprovalEvents.push({
                owner,
                operator,
                approved,
                baseEventParams,
              });

              // Make sure to only handle the same data once per on-chain event
              // (instead of once per transaction as we do with balance updates
              // since we're handling nft approvals differently - checking them
              // individually).
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${baseEventParams.logIndex}`;

              makerInfos.push({
                context: `${contextPrefix}-${owner}-sell-approval`,
                maker: owner,
                trigger: {
                  kind: "approval-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-approval",
                  contract: baseEventParams.address,
                  operator,
                },
              });

              break;
            }

            // Erc20

            case "erc20-transfer": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const amount = parsedLog.args["amount"].toString();

              ftTransferEvents.push({
                from,
                to,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-buy-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });
              makerInfos.push({
                context: `${contextPrefix}-${to}-buy-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });

              break;
            }

            case "erc20-approval": {
              const parsedLog = eventData.abi.parseLog(log);
              const owner = parsedLog.args["owner"].toLowerCase();
              const spender = parsedLog.args["spender"].toLowerCase();

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${owner}-${spender}-buy-approval`,
                maker: owner,
                trigger: {
                  kind: "approval-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-approval",
                  contract: Sdk.Common.Addresses.Weth[config.chainId],
                  operator: spender,
                },
              });

              break;
            }

            // Weth

            case "weth-deposit": {
              const parsedLog = eventData.abi.parseLog(log);
              const to = parsedLog.args["to"].toLowerCase();
              const amount = parsedLog.args["amount"].toString();

              ftTransferEvents.push({
                from: AddressZero,
                to,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${to}-buy-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });

              break;
            }

            case "weth-withdrawal": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const amount = parsedLog.args["amount"].toString();

              ftTransferEvents.push({
                from,
                to: AddressZero,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-buy-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });

              break;
            }

            // X2Y2

            case "x2y2-order-cancelled": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["itemHash"].toLowerCase();

              cancelEvents.push({
                orderKind: "x2y2",
                orderId,
                baseEventParams,
              });
              orderInfos.push({
                context: `cancelled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "cancel",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                  logIndex: baseEventParams.logIndex,
                  batchIndex: baseEventParams.batchIndex,
                  blockHash: baseEventParams.blockHash,
                },
              });

              break;
            }

            case "x2y2-order-inventory": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["itemHash"].toLowerCase();
              const maker = parsedLog.args["maker"].toLowerCase();
              let taker = parsedLog.args["taker"].toLowerCase();
              const currency = parsedLog.args["currency"].toLowerCase();
              const item = parsedLog.args["item"];
              const op = parsedLog.args["detail"].op;

              // 1 - COMPLETE_SELL_OFFER
              // 2 - COMPLETE_BUY_OFFER
              // 5 - COMPLETE_AUCTION
              if (![1, 2, 5].includes(op)) {
                // Skip any irrelevant events
                break;
              }

              const orderKind = "x2y2";

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              // Decode the sold token (ignoring bundles)
              let contract: string;
              let tokenId: string;
              try {
                const decodedItems = defaultAbiCoder.decode(
                  ["(address contract, uint256 tokenId)[]"],
                  item.data
                );
                if (decodedItems[0].length !== 1) {
                  break;
                }

                contract = decodedItems[0][0].contract.toLowerCase();
                tokenId = decodedItems[0][0].tokenId.toString();
              } catch {
                break;
              }

              const orderSide = [1, 5].includes(op) ? "sell" : "buy";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              // Handle: prices
              const currencyPrice = item.price.toString();
              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              fillEvents.push({
                orderKind,
                orderId,
                orderSide,
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract,
                tokenId,
                // X2Y2 only supports ERC721 for now
                amount: "1",
                aggregatorSourceId: data.aggregatorSource?.id,
                fillSourceId: data.fillSource?.id,
                baseEventParams,
              });

              orderInfos.push({
                context: `filled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              fillInfos.push({
                context: `${orderId}-${baseEventParams.txHash}`,
                orderId: orderId,
                orderSide,
                contract,
                tokenId,
                amount: "1",
                price: prices.nativePrice,
                timestamp: baseEventParams.timestamp,
              });

              if (currentTxHasWethTransfer()) {
                makerInfos.push({
                  context: `${baseEventParams.txHash}-buy-approval`,
                  maker,
                  trigger: {
                    kind: "approval-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "buy-approval",
                    contract: Sdk.Common.Addresses.Weth[config.chainId],
                    orderKind: "x2y2",
                  },
                });
              }

              break;
            }

            // Foundation

            case "foundation-buy-price-set": {
              const parsedLog = eventData.abi.parseLog(log);
              const contract = parsedLog.args["nftContract"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();
              const maker = parsedLog.args["seller"].toLowerCase();
              const price = parsedLog.args["price"].toString();

              foundationOrders.push({
                orderParams: {
                  contract,
                  tokenId,
                  maker,
                  price,
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                metadata: {
                  source: "Foundation",
                },
              });

              break;
            }

            case "foundation-buy-price-accepted": {
              const parsedLog = eventData.abi.parseLog(log);
              const contract = parsedLog.args["nftContract"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();
              const maker = parsedLog.args["seller"].toLowerCase();
              let taker = parsedLog.args["buyer"].toLowerCase();
              const protocolFee = parsedLog.args["protocolFee"].toString();

              const orderId = keccak256(["address", "uint256"], [contract, tokenId]);
              const orderKind = "foundation";

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              const orderSource = await getOrderSourceByOrderKind(orderKind);

              // Handle: prices
              const currency = Sdk.Common.Addresses.Eth[config.chainId];
              // Deduce the price from the protocol fee (which is 5%)
              const currencyPrice = bn(protocolFee).mul(10000).div(50).toString();
              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              // Custom handling to support on-chain orderbook quirks.
              fillEventsFoundation.push({
                orderKind,
                orderId,
                orderSide: "sell",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract,
                tokenId,
                // Foundation only supports erc721 for now
                amount: "1",
                aggregatorSourceId: data.aggregatorSource?.id,
                fillSourceId: data.fillSource?.id,
                baseEventParams,
              });

              orderInfos.push({
                context: `filled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              fillInfos.push({
                context: `${orderId}-${baseEventParams.txHash}`,
                orderId: orderId,
                orderSide: "sell",
                contract,
                tokenId,
                amount: "1",
                price: prices.nativePrice,
                timestamp: baseEventParams.timestamp,
              });

              break;
            }

            case "foundation-buy-price-invalidated":
            case "foundation-buy-price-cancelled": {
              const parsedLog = eventData.abi.parseLog(log);
              const contract = parsedLog.args["nftContract"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();

              const orderId = keccak256(["address", "uint256"], [contract, tokenId]);

              // Custom handling to support on-chain orderbook quirks.
              cancelEventsFoundation.push({
                orderKind: "foundation",
                orderId,
                baseEventParams,
              });
              orderInfos.push({
                context: `cancelled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "cancel",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                  logIndex: baseEventParams.logIndex,
                  batchIndex: baseEventParams.batchIndex,
                  blockHash: baseEventParams.blockHash,
                },
              });

              break;
            }

            // LooksRare

            case "looks-rare-cancel-all-orders": {
              const parsedLog = eventData.abi.parseLog(log);
              const maker = parsedLog.args["user"].toLowerCase();
              const newMinNonce = parsedLog.args["newMinNonce"].toString();

              bulkCancelEvents.push({
                orderKind: "looks-rare",
                maker,
                minNonce: newMinNonce,
                baseEventParams,
              });

              break;
            }

            case "looks-rare-cancel-multiple-orders": {
              const parsedLog = eventData.abi.parseLog(log);
              const maker = parsedLog.args["user"].toLowerCase();
              const orderNonces = parsedLog.args["orderNonces"].map(String);

              let batchIndex = 1;
              for (const orderNonce of orderNonces) {
                nonceCancelEvents.push({
                  orderKind: "looks-rare",
                  maker,
                  nonce: orderNonce,
                  baseEventParams: {
                    ...baseEventParams,
                    batchIndex: batchIndex++,
                  },
                });
              }

              break;
            }

            case "looks-rare-taker-ask": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();
              const orderNonce = parsedLog.args["orderNonce"].toString();
              const maker = parsedLog.args["maker"].toLowerCase();
              let taker = parsedLog.args["taker"].toLowerCase();
              const currency = parsedLog.args["currency"].toLowerCase();
              let currencyPrice = parsedLog.args["price"].toString();
              const contract = parsedLog.args["collection"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();
              const amount = parsedLog.args["amount"].toString();

              const orderKind = "looks-rare";

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              const orderSource = await getOrderSourceByOrderKind(orderKind);

              // Handle: prices
              currencyPrice = bn(currencyPrice).div(amount).toString();
              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              fillEvents.push({
                orderKind,
                orderId,
                orderSide: "buy",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract,
                tokenId,
                amount,
                aggregatorSourceId: data.aggregatorSource?.id,
                fillSourceId: data.fillSource?.id,
                baseEventParams,
              });

              // Cancel all the other orders of the maker having the same nonce.
              nonceCancelEvents.push({
                orderKind: "looks-rare",
                maker,
                nonce: orderNonce,
                baseEventParams,
              });

              orderInfos.push({
                context: `filled-${orderId}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              fillInfos.push({
                context: orderId,
                orderId: orderId,
                orderSide: "buy",
                contract,
                tokenId,
                amount,
                price: prices.nativePrice,
                timestamp: baseEventParams.timestamp,
              });

              if (currentTxHasWethTransfer()) {
                makerInfos.push({
                  context: `${baseEventParams.txHash}-buy-approval`,
                  maker,
                  trigger: {
                    kind: "approval-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "buy-approval",
                    contract: Sdk.Common.Addresses.Weth[config.chainId],
                    orderKind: "looks-rare",
                  },
                });
              }

              break;
            }

            case "looks-rare-taker-bid": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();
              const orderNonce = parsedLog.args["orderNonce"].toString();
              const maker = parsedLog.args["maker"].toLowerCase();
              let taker = parsedLog.args["taker"].toLowerCase();
              const currency = parsedLog.args["currency"].toLowerCase();
              let currencyPrice = parsedLog.args["price"].toString();
              const contract = parsedLog.args["collection"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();
              const amount = parsedLog.args["amount"].toString();

              const orderKind = "looks-rare";

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              const orderSource = await getOrderSourceByOrderKind(orderKind);

              // Handle: prices
              currencyPrice = bn(currencyPrice).div(amount).toString();
              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              fillEvents.push({
                orderKind,
                orderId,
                orderSide: "sell",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract,
                tokenId,
                amount,
                aggregatorSourceId: data.aggregatorSource?.id,
                fillSourceId: data.fillSource?.id,
                baseEventParams,
              });

              // Cancel all the other orders of the maker having the same nonce.
              nonceCancelEvents.push({
                orderKind: "looks-rare",
                maker,
                nonce: orderNonce,
                baseEventParams,
              });

              orderInfos.push({
                context: `filled-${orderId}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              fillInfos.push({
                context: orderId,
                orderId: orderId,
                orderSide: "sell",
                contract,
                tokenId,
                amount,
                price: prices.nativePrice,
                timestamp: baseEventParams.timestamp,
              });

              if (currentTxHasWethTransfer()) {
                makerInfos.push({
                  context: `${baseEventParams.txHash}-buy-approval`,
                  maker,
                  trigger: {
                    kind: "approval-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "buy-approval",
                    contract: Sdk.Common.Addresses.Weth[config.chainId],
                    orderKind: "looks-rare",
                  },
                });
              }

              break;
            }

            // WyvernV2/WyvernV2.3

            // Wyvern V2 and V2.3 are both decomissioned, but we still keep handling
            // fill event from them in order to get access to historical sales. This
            // is only relevant when backfilling though.

            case "wyvern-v2-orders-matched":
            case "wyvern-v2.3-orders-matched": {
              const parsedLog = eventData.abi.parseLog(log);
              const buyOrderId = parsedLog.args["buyHash"].toLowerCase();
              const sellOrderId = parsedLog.args["sellHash"].toLowerCase();
              const maker = parsedLog.args["maker"].toLowerCase();
              let taker = parsedLog.args["taker"].toLowerCase();
              const currencyPrice = parsedLog.args["price"].toString();

              // The code below assumes that events are retrieved in chronological
              // order from the blockchain (this is safe to assume in most cases).

              // With Wyvern, there are two main issues:
              // - the traded token is not included in the fill event, so we have
              // to deduce it by checking the nft transfer occured exactly before
              // the fill event
              // - the payment token is not included in the fill event, and we deduce
              // it as well by checking any Erc20 transfers that occured close before
              // the fill event (and default to native Eth if cannot find any)

              // Detect the traded token
              let associatedNftTransferEvent: es.nftTransfers.Event | undefined;
              if (nftTransferEvents.length) {
                // Ensure the last nft transfer event was part of the fill
                const event = nftTransferEvents[nftTransferEvents.length - 1];
                if (
                  event.baseEventParams.txHash === baseEventParams.txHash &&
                  event.baseEventParams.logIndex === baseEventParams.logIndex - 1 &&
                  // Only single token fills are supported and recognized
                  event.baseEventParams.batchIndex === 1
                ) {
                  associatedNftTransferEvent = event;
                }
              }

              if (!associatedNftTransferEvent) {
                // Skip if we can't associate to an nft transfer event
                break;
              }

              // Detect the payment token
              let currency = Sdk.Common.Addresses.Eth[config.chainId];
              for (const event of currentTxEvents.slice(0, -1).reverse()) {
                // Skip once we detect another fill in the same transaction
                // (this will happen if filling through an aggregator).
                if (event.log.topics[0] === getEventData([eventData.kind])[0].topic) {
                  break;
                }

                // If we detect an Erc20 transfer as part of the same transaction
                // then we assume it's the payment for the current sale and so we
                // only keep the sale if the payment token is Weth.
                const erc20EventData = getEventData(["erc20-transfer"])[0];
                if (
                  event.log.topics[0] === erc20EventData.topic &&
                  event.log.topics.length === erc20EventData.numTopics
                ) {
                  const parsed = erc20EventData.abi.parseLog(event.log);
                  const from = parsed.args["from"].toLowerCase();
                  const to = parsed.args["to"].toLowerCase();
                  const amount = parsed.args["amount"].toString();
                  if (
                    ((maker === from && taker === to) || (maker === to && taker === from)) &&
                    amount <= currencyPrice
                  ) {
                    currency = event.log.address.toLowerCase();
                    break;
                  }
                }
              }

              const orderKind = eventData.kind.startsWith("wyvern-v2.3")
                ? "wyvern-v2.3"
                : "wyvern-v2";

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              // Handle: prices
              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderSource = await getOrderSourceByOrderKind(orderKind);

              let batchIndex = 1;
              if (buyOrderId !== HashZero) {
                fillEvents.push({
                  orderKind,
                  orderId: buyOrderId,
                  orderSide: "buy",
                  orderSourceIdInt: orderSource?.id,
                  maker,
                  taker,
                  price: prices.nativePrice,
                  currency,
                  currencyPrice,
                  usdPrice: prices.usdPrice,
                  contract: associatedNftTransferEvent.baseEventParams.address,
                  tokenId: associatedNftTransferEvent.tokenId,
                  amount: associatedNftTransferEvent.amount,
                  aggregatorSourceId: data.aggregatorSource?.id,
                  fillSourceId: data.fillSource?.id,
                  baseEventParams: {
                    ...baseEventParams,
                    batchIndex: batchIndex++,
                  },
                });
              }
              if (sellOrderId !== HashZero) {
                fillEvents.push({
                  orderKind,
                  orderId: sellOrderId,
                  orderSide: "sell",
                  orderSourceIdInt: orderSource?.id,
                  maker,
                  taker,
                  price: prices.nativePrice,
                  currency,
                  currencyPrice,
                  usdPrice: prices.usdPrice,
                  contract: associatedNftTransferEvent.baseEventParams.address,
                  tokenId: associatedNftTransferEvent.tokenId,
                  amount: associatedNftTransferEvent.amount,
                  aggregatorSourceId: data.aggregatorSource?.id,
                  fillSourceId: data.fillSource?.id,
                  baseEventParams: {
                    ...baseEventParams,
                    batchIndex: batchIndex++,
                  },
                });
              }

              break;
            }

            // ZeroExV4 + OpenDao

            case "zeroex-v4-erc721-order-cancelled":
            case "zeroex-v4-erc1155-order-cancelled":
            case "opendao-erc721-order-cancelled":
            case "opendao-erc1155-order-cancelled": {
              const parsedLog = eventData.abi.parseLog(log);
              const maker = parsedLog.args["maker"].toLowerCase();
              const nonce = parsedLog.args["nonce"].toString();

              nonceCancelEvents.push({
                orderKind: eventData!.kind.split("-").slice(0, -2).join("-") as OrderKind,
                maker,
                nonce,
                baseEventParams,
              });

              break;
            }

            case "zeroex-v4-erc721-order-filled":
            case "opendao-erc721-order-filled": {
              const parsedLog = eventData.abi.parseLog(log);
              const direction = parsedLog.args["direction"];
              const maker = parsedLog.args["maker"].toLowerCase();
              let taker = parsedLog.args["taker"].toLowerCase();
              const nonce = parsedLog.args["nonce"].toString();
              const erc20Token = parsedLog.args["erc20Token"].toLowerCase();
              const erc20TokenAmount = parsedLog.args["erc20TokenAmount"].toString();
              const erc721Token = parsedLog.args["erc721Token"].toLowerCase();
              const erc721TokenId = parsedLog.args["erc721TokenId"].toString();

              const orderKind = eventData!.kind.split("-").slice(0, -2).join("-") as OrderKind;

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              // By default, use the price without fees
              let currencyPrice = erc20TokenAmount;

              let orderId: string | undefined;
              if (!backfill) {
                // Since the event doesn't include the exact order which got matched
                // (it only includes the nonce, but we can potentially have multiple
                // different orders sharing the same nonce off-chain), we attempt to
                // detect the order id which got filled by checking the database for
                // orders which have the exact nonce/contract/price combination.
                await idb
                  .oneOrNone(
                    `
                      SELECT
                        orders.id,
                        orders.price
                      FROM orders
                      WHERE orders.kind = '${orderKind}'
                        AND orders.maker = $/maker/
                        AND orders.nonce = $/nonce/
                        AND orders.contract = $/contract/
                        AND (orders.raw_data ->> 'erc20TokenAmount')::NUMERIC = $/price/
                      LIMIT 1
                    `,
                    {
                      maker: toBuffer(maker),
                      nonce,
                      contract: toBuffer(erc721Token),
                      price: erc20TokenAmount,
                    }
                  )
                  .then((result) => {
                    if (result) {
                      orderId = result.id;
                      // Workaround the fact that 0xv4 fill events exclude the fee from the price
                      currencyPrice = result.price;
                    }
                  });
              }

              // Handle: prices
              let currency = erc20Token;
              if (currency === Sdk.ZeroExV4.Addresses.Eth[config.chainId]) {
                // Map the weird 0x ETH address
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              }

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderSide = direction === 0 ? "sell" : "buy";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              fillEvents.push({
                orderKind,
                orderId,
                orderSide,
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract: erc721Token,
                tokenId: erc721TokenId,
                amount: "1",
                aggregatorSourceId: data.aggregatorSource?.id,
                fillSourceId: data.fillSource?.id,
                baseEventParams,
              });

              // Cancel all the other orders of the maker having the same nonce.
              nonceCancelEvents.push({
                orderKind,
                maker,
                nonce,
                baseEventParams,
              });

              if (orderId) {
                orderInfos.push({
                  context: `filled-${orderId}`,
                  id: orderId,
                  trigger: {
                    kind: "sale",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                });
              }

              fillInfos.push({
                context: orderId || `${maker}-${nonce}`,
                orderId: orderId,
                orderSide,
                contract: erc721Token,
                tokenId: erc721TokenId,
                amount: "1",
                price: prices.nativePrice,
                timestamp: baseEventParams.timestamp,
              });

              if (currentTxHasWethTransfer()) {
                makerInfos.push({
                  context: `${baseEventParams.txHash}-buy-approval`,
                  maker,
                  trigger: {
                    kind: "approval-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "buy-approval",
                    contract: Sdk.Common.Addresses.Weth[config.chainId],
                    orderKind: orderKind,
                  },
                });
              }

              break;
            }

            case "zeroex-v4-erc1155-order-filled":
            case "opendao-erc1155-order-filled": {
              const parsedLog = eventData.abi.parseLog(log);
              const direction = parsedLog.args["direction"];
              const maker = parsedLog.args["maker"].toLowerCase();
              let taker = parsedLog.args["taker"].toLowerCase();
              const nonce = parsedLog.args["nonce"].toString();
              const erc20Token = parsedLog.args["erc20Token"].toLowerCase();
              const erc20FillAmount = parsedLog.args["erc20FillAmount"].toString();
              const erc1155Token = parsedLog.args["erc1155Token"].toLowerCase();
              const erc1155TokenId = parsedLog.args["erc1155TokenId"].toString();
              const erc1155FillAmount = parsedLog.args["erc1155FillAmount"].toString();

              const orderKind = eventData!.kind.split("-").slice(0, -2).join("-") as OrderKind;

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              // By default, use the price without fees
              let currencyPrice = bn(erc20FillAmount).div(erc1155FillAmount).toString();

              let orderId: string | undefined;
              if (!backfill) {
                // For erc1155 orders we only allow unique nonce/contract/price. Since erc1155
                // orders are partially fillable, we have to detect the price of an individual
                // item from the fill amount, which might result in imprecise results. However
                // at the moment, we can live with it.
                await idb
                  .oneOrNone(
                    `
                      SELECT
                        orders.id,
                        orders.price
                      FROM orders
                      WHERE orders.kind = '${orderKind}'
                        AND orders.maker = $/maker/
                        AND orders.nonce = $/nonce/
                        AND orders.contract = $/contract/
                        AND (orders.raw_data ->> 'erc20TokenAmount')::NUMERIC / (orders.raw_data ->> 'nftAmount')::NUMERIC = $/price/
                      LIMIT 1
                    `,
                    {
                      maker: toBuffer(maker),
                      nonce,
                      contract: toBuffer(erc1155Token),
                      price: bn(erc20FillAmount).div(erc1155FillAmount).toString(),
                    }
                  )
                  .then((result) => {
                    if (result) {
                      orderId = result.id;
                      // Workaround the fact that 0xv4 fill events exclude the fee from the price
                      currencyPrice = bn(result.price).mul(erc1155FillAmount).toString();
                    }
                  });
              }

              // Handle: prices
              let currency = erc20Token;
              if (currency === Sdk.ZeroExV4.Addresses.Eth[config.chainId]) {
                // Map the weird 0x ETH address
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              }

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderSide = direction === 0 ? "sell" : "buy";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              // Custom handling to support partial filling
              fillEventsPartial.push({
                orderKind,
                orderId,
                orderSide,
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract: erc1155Token,
                tokenId: erc1155TokenId,
                amount: erc1155FillAmount,
                aggregatorSourceId: data.aggregatorSource?.id,
                fillSourceId: data.fillSource?.id,
                baseEventParams,
              });

              if (orderId) {
                orderInfos.push({
                  context: `filled-${orderId}-${baseEventParams.txHash}`,
                  id: orderId,
                  trigger: {
                    kind: "sale",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                });
              }

              fillInfos.push({
                context: orderId || `${maker}-${nonce}`,
                orderId: orderId,
                orderSide,
                contract: erc1155Token,
                tokenId: erc1155TokenId,
                amount: erc1155FillAmount,
                price: prices.nativePrice,
                timestamp: baseEventParams.timestamp,
              });

              if (currentTxHasWethTransfer()) {
                makerInfos.push({
                  context: `${baseEventParams.txHash}-buy-approval`,
                  maker,
                  trigger: {
                    kind: "approval-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "buy-approval",
                    contract: Sdk.Common.Addresses.Weth[config.chainId],
                    orderKind: orderKind,
                  },
                });
              }

              break;
            }

            case "seaport-order-cancelled": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();

              cancelEvents.push({
                orderKind: "seaport",
                orderId,
                baseEventParams,
              });

              orderInfos.push({
                context: `cancelled-${orderId}`,
                id: orderId,
                trigger: {
                  kind: "cancel",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                  logIndex: baseEventParams.logIndex,
                  batchIndex: baseEventParams.batchIndex,
                  blockHash: baseEventParams.blockHash,
                },
              });

              break;
            }

            case "seaport-counter-incremented": {
              const parsedLog = eventData.abi.parseLog(log);
              const maker = parsedLog.args["offerer"].toLowerCase();
              const newCounter = parsedLog.args["newCounter"].toString();

              bulkCancelEvents.push({
                orderKind: "seaport",
                maker,
                minNonce: newCounter,
                baseEventParams,
              });

              break;
            }

            case "seaport-order-filled": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();
              const maker = parsedLog.args["offerer"].toLowerCase();
              let taker = parsedLog.args["recipient"].toLowerCase();
              const offer = parsedLog.args["offer"];
              const consideration = parsedLog.args["consideration"];

              const saleInfo = new Sdk.Seaport.Exchange(config.chainId).deriveBasicSale(
                offer,
                consideration
              );
              if (saleInfo) {
                const orderSide = saleInfo.side as "sell" | "buy";
                const orderKind = "seaport";

                // Handle: prices
                const currency = saleInfo.paymentToken;
                const currencyPrice = bn(saleInfo.price).div(saleInfo.amount).toString();
                const prices = await getUSDAndNativePrices(
                  currency,
                  currencyPrice,
                  baseEventParams.timestamp
                );
                if (!prices.nativePrice) {
                  // We must always have the native price
                  break;
                }

                // Handle: attribution
                const data = await syncEventsUtils.extractAttributionData(
                  baseEventParams.txHash,
                  orderKind
                );
                if (data.taker) {
                  taker = data.taker;
                }

                if (saleInfo.recipientOverride) {
                  taker = saleInfo.recipientOverride;
                }

                const orderSource = await getOrderSourceByOrderKind(orderKind);

                // Custom handling to support partial filling
                fillEventsPartial.push({
                  orderKind,
                  orderId,
                  orderSide,
                  orderSourceIdInt: orderSource?.id,
                  maker,
                  taker,
                  price: prices.nativePrice,
                  currency,
                  currencyPrice,
                  usdPrice: prices.usdPrice,
                  contract: saleInfo.contract,
                  tokenId: saleInfo.tokenId,
                  amount: saleInfo.amount,
                  aggregatorSourceId: data.aggregatorSource?.id,
                  fillSourceId: data.fillSource?.id,
                  baseEventParams,
                });

                fillInfos.push({
                  context: `${orderId}-${baseEventParams.txHash}`,
                  orderId: orderId,
                  orderSide,
                  contract: saleInfo.contract,
                  tokenId: saleInfo.tokenId,
                  amount: saleInfo.amount,
                  price: prices.nativePrice,
                  timestamp: baseEventParams.timestamp,
                });
              }

              orderInfos.push({
                context: `filled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              break;
            }

            case "rarible-match": {
              const { args } = eventData.abi.parseLog(log);
              const leftHash = args["leftHash"].toLowerCase();
              const leftMaker = args["leftMaker"].toLowerCase();
              const rightMaker = args["rightMaker"].toLowerCase();
              const newLeftFill = args["newLeftFill"].toString();
              const newRightFill = args["newRightFill"].toString();
              const leftAsset = args["leftAsset"];
              const rightAsset = args["rightAsset"];

              const ERC20 = "0x8ae85d84";
              const ETH = "0xaaaebeba";
              const ERC721 = "0x73ad2146";
              const ERC1155 = "0x973bb640";

              const assetTypes = [ERC721, ERC1155, ERC20, ETH];

              // Exclude orders with exotic asset types
              if (
                !assetTypes.includes(leftAsset.assetClass) ||
                !assetTypes.includes(rightAsset.assetClass)
              ) {
                break;
              }

              // Assume the left order is the maker's order
              const side = [ERC721, ERC1155].includes(leftAsset.assetClass) ? "sell" : "buy";

              const currencyAsset = side === "sell" ? rightAsset : leftAsset;
              const nftAsset = side === "sell" ? leftAsset : rightAsset;

              let currency: string;
              if (currencyAsset.assetClass === ETH) {
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              } else if (currencyAsset.assetClass === ERC20) {
                const decodedCurrencyAsset = defaultAbiCoder.decode(
                  ["(address token)"],
                  currencyAsset.data
                );
                currency = decodedCurrencyAsset[0][0];
              } else {
                break;
              }

              const decodedNftAsset = defaultAbiCoder.decode(
                ["(address token, uint tokenId)"],
                nftAsset.data
              );

              const contract = decodedNftAsset[0][0].toLowerCase();
              const tokenId = decodedNftAsset[0][1].toString();

              let currencyPrice = side === "sell" ? newLeftFill : newRightFill;
              const amount = side === "sell" ? newRightFill : newLeftFill;
              currencyPrice = bn(currencyPrice).div(amount).toString();

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderKind = "rarible";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              let taker = rightMaker;

              // Handle attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );

              if (data.taker) {
                taker = data.taker;
              }

              fillEventsPartial.push({
                orderKind: "rarible",
                orderId: leftHash,
                orderSide: side,
                orderSourceIdInt: orderSource?.id,
                maker: leftMaker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract,
                tokenId,
                amount,
                baseEventParams,
              });

              break;
            }

            case "element-erc721-sell-order-filled": {
              const { args } = eventData.abi.parseLog(log);
              const maker = args["maker"].toLowerCase();
              const taker = args["taker"].toLowerCase();
              const erc20Token = args["erc20Token"].toLowerCase();
              const erc20TokenAmount = args["erc20TokenAmount"].toString();
              const erc721Token = args["erc721Token"].toLowerCase();
              const erc721TokenId = args["erc721TokenId"].toString();
              const orderHash = args["orderHash"].toLowerCase();

              // Handle: prices
              let currency = erc20Token;
              if (currency === Sdk.ZeroExV4.Addresses.Eth[config.chainId]) {
                // Map the weird 0x ETH address
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              }
              const currencyPrice = erc20TokenAmount;

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderKind = "element-erc721";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              fillEventsPartial.push({
                orderKind,
                orderId: orderHash,
                orderSide: "sell",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract: erc721Token,
                tokenId: erc721TokenId,
                amount: "1",
                baseEventParams,
              });

              break;
            }

            case "element-erc721-buy-order-filled": {
              const { args } = eventData.abi.parseLog(log);
              const maker = args["maker"].toLowerCase();
              const taker = args["taker"].toLowerCase();
              const erc20Token = args["erc20Token"].toLowerCase();
              const erc20TokenAmount = args["erc20TokenAmount"].toString();
              const erc721Token = args["erc721Token"].toLowerCase();
              const erc721TokenId = args["erc721TokenId"].toString();
              const orderHash = args["orderHash"].toLowerCase();

              // Handle: prices
              let currency = erc20Token;
              if (currency === Sdk.ZeroExV4.Addresses.Eth[config.chainId]) {
                // Map the weird 0x ETH address
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              }
              const currencyPrice = erc20TokenAmount;

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderKind = "element-erc721";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              fillEventsPartial.push({
                orderKind,
                orderId: orderHash,
                orderSide: "buy",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract: erc721Token,
                tokenId: erc721TokenId,
                amount: "1",
                baseEventParams,
              });

              break;
            }

            case "element-erc1155-sell-order-filled": {
              const { args } = eventData.abi.parseLog(log);
              const maker = args["maker"].toLowerCase();
              const taker = args["taker"].toLowerCase();
              const erc20Token = args["erc20Token"].toLowerCase();
              const erc20FillAmount = args["erc20FillAmount"].toString();
              const erc1155Token = args["erc1155Token"].toLowerCase();
              const erc1155TokenId = args["erc1155TokenId"].toString();
              const erc1155FillAmount = args["erc1155FillAmount"].toString();
              const orderHash = args["orderHash"].toLowerCase();

              // Handle: prices
              let currency = erc20Token;
              if (currency === Sdk.ZeroExV4.Addresses.Eth[config.chainId]) {
                // Map the weird 0x ETH address
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              }
              const currencyPrice = bn(erc20FillAmount).div(erc1155FillAmount).toString();

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderKind = "element-erc1155";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              fillEventsPartial.push({
                orderKind,
                orderId: orderHash,
                orderSide: "sell",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract: erc1155Token,
                tokenId: erc1155TokenId,
                amount: erc1155FillAmount,
                baseEventParams,
              });

              break;
            }

            case "element-erc1155-buy-order-filled": {
              const { args } = eventData.abi.parseLog(log);
              const maker = args["maker"].toLowerCase();
              const taker = args["taker"].toLowerCase();
              const erc20Token = args["erc20Token"].toLowerCase();
              const erc20FillAmount = args["erc20FillAmount"].toString();
              const erc1155Token = args["erc1155Token"].toLowerCase();
              const erc1155TokenId = args["erc1155TokenId"].toString();
              const erc1155FillAmount = args["erc1155FillAmount"].toString();
              const orderHash = args["orderHash"].toLowerCase();

              // Handle: prices
              let currency = erc20Token;
              if (currency === Sdk.ZeroExV4.Addresses.Eth[config.chainId]) {
                // Map the weird 0x ETH address
                currency = Sdk.Common.Addresses.Eth[config.chainId];
              }
              const currencyPrice = bn(erc20FillAmount).div(erc1155FillAmount).toString();

              const prices = await getUSDAndNativePrices(
                currency,
                currencyPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderKind = "element-erc1155";
              const orderSource = await getOrderSourceByOrderKind(orderKind);

              fillEventsPartial.push({
                orderKind,
                orderId: orderHash,
                orderSide: "buy",
                orderSourceIdInt: orderSource?.id,
                maker,
                taker,
                price: prices.nativePrice,
                currency,
                currencyPrice,
                usdPrice: prices.usdPrice,
                contract: erc1155Token,
                tokenId: erc1155TokenId,
                amount: erc1155FillAmount,
                baseEventParams,
              });

              break;
            }

            case "quixotic-order-filled": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();
              const maker = parsedLog.args["offerer"].toLowerCase();
              let taker = parsedLog.args["recipient"].toLowerCase();
              const offer = parsedLog.args["offer"];
              const consideration = parsedLog.args["consideration"];

              // TODO: Switch to `Quixotic` class once integrated
              const saleInfo = new Sdk.Seaport.Exchange(config.chainId).deriveBasicSale(
                offer,
                consideration
              );
              if (saleInfo) {
                let side: "sell" | "buy";
                if (saleInfo.paymentToken === Sdk.Common.Addresses.Eth[config.chainId]) {
                  side = "sell";
                } else if (saleInfo.paymentToken === Sdk.Common.Addresses.Weth[config.chainId]) {
                  side = "buy";
                } else {
                  break;
                }

                if (saleInfo.recipientOverride) {
                  taker = saleInfo.recipientOverride;
                }

                const orderKind = "quixotic";

                // Handle attribution
                const data = await syncEventsUtils.extractAttributionData(
                  baseEventParams.txHash,
                  orderKind
                );
                if (data.taker) {
                  taker = data.taker;
                }

                // Handle: prices
                const currency = saleInfo.paymentToken;
                const currencyPrice = bn(saleInfo.price).div(saleInfo.amount).toString();
                const prices = await getUSDAndNativePrices(
                  currency,
                  currencyPrice,
                  baseEventParams.timestamp
                );
                if (!prices.nativePrice) {
                  // We must always have the native price
                  break;
                }

                const orderSource = await getOrderSourceByOrderKind(orderKind);

                // Custom handling to support partial filling
                fillEventsPartial.push({
                  orderKind,
                  orderId,
                  orderSide: side,
                  orderSourceIdInt: orderSource?.id,
                  maker,
                  taker,
                  price: prices.nativePrice,
                  currency,
                  currencyPrice,
                  usdPrice: prices.usdPrice,
                  contract: saleInfo.contract,
                  tokenId: saleInfo.tokenId,
                  amount: saleInfo.amount,
                  aggregatorSourceId: data.aggregatorSource?.id,
                  fillSourceId: data.fillSource?.id,
                  baseEventParams,
                });

                fillInfos.push({
                  context: `${orderId}-${baseEventParams.txHash}`,
                  orderId: orderId,
                  orderSide: side,
                  contract: saleInfo.contract,
                  tokenId: saleInfo.tokenId,
                  amount: saleInfo.amount,
                  price: prices.nativePrice,
                  timestamp: baseEventParams.timestamp,
                });
              }

              orderInfos.push({
                context: `filled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              break;
            }

            case "zora-ask-filled": {
              const { args } = eventData.abi.parseLog(log);
              const tokenContract = args["tokenContract"].toLowerCase();
              const tokenId = args["tokenId"].toString();
              const buyer = args["buyer"].toLowerCase();
              const ask = args["ask"];

              const seller = ask["seller"].toLowerCase();
              const askCurrency = ask["askCurrency"].toLowerCase();
              const askPrice = ask["askPrice"].toString();

              const orderKind = "zora-v3";

              // Handle: attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );

              // Handle: prices
              const prices = await getUSDAndNativePrices(
                askCurrency,
                askPrice,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const source = await getOrderSourceByOrderKind(orderKind);
              fillEvents.push({
                orderKind,
                orderSourceIdInt: source?.id,
                currency: askCurrency,
                orderSide: "sell",
                maker: seller,
                taker: buyer,
                price: prices.nativePrice,
                usdPrice: prices.usdPrice,
                contract: tokenContract,
                tokenId,
                amount: "1",
                fillSourceId: data.fillSource?.id,
                aggregatorSourceId: data.aggregatorSource?.id,
                baseEventParams,
              });

              break;
            }

            case "zora-auction-ended": {
              const { args } = eventData.abi.parseLog(log);
              const tokenId = args["tokenId"].toString();
              const tokenContract = args["tokenContract"].toLowerCase();
              const tokenOwner = args["tokenOwner"].toLowerCase();
              const winner = args["winner"].toLowerCase();
              const amount = args["amount"].toString();
              const auctionCurrency = args["auctionCurrency"].toLowerCase();

              const orderKind = "zora-v3";

              // Handle: attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );

              // Handle: prices
              const prices = await getUSDAndNativePrices(
                auctionCurrency,
                amount,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const source = await getOrderSourceByOrderKind(orderKind);
              fillEvents.push({
                orderKind,
                orderSourceIdInt: source?.id,
                currency: auctionCurrency,
                orderSide: "sell",
                taker: winner,
                maker: tokenOwner,
                price: prices.nativePrice,
                usdPrice: prices.usdPrice,
                contract: tokenContract,
                tokenId,
                amount: "1",
                fillSourceId: data.fillSource?.id,
                aggregatorSourceId: data.fillSource?.id,
                baseEventParams,
              });

              break;
            }

            case "nouns-auction-settled": {
              const { args } = eventData.abi.parseLog(log);
              const nounId = args["nounId"].toString();
              const winner = args["winner"].toLowerCase();
              const amount = args["amount"].toString();

              const orderKind = "nouns";

              // Handle: attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );

              // Handle: prices
              const currency = Sdk.Common.Addresses.Eth[config.chainId];
              const prices = await getUSDAndNativePrices(
                currency,
                amount,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const orderSource = await getOrderSourceByOrderKind(orderKind);
              fillEvents.push({
                orderKind,
                orderSourceIdInt: orderSource?.id,
                orderSide: "sell",
                maker: Sdk.Nouns.Addresses.AuctionHouse[config.chainId]?.toLowerCase(),
                taker: winner,
                amount: "1",
                currency,
                price: prices.nativePrice,
                usdPrice: prices.usdPrice,
                contract: Sdk.Nouns.Addresses.TokenContract[config.chainId]?.toLowerCase(),
                tokenId: nounId,
                fillSourceId: data.fillSource?.id,
                aggregatorSourceId: data.aggregatorSource?.id,
                baseEventParams,
              });

              break;
            }

            case "cryptopunks-punk-bought": {
              const { args } = eventData.abi.parseLog(log);
              const punkIndex = args["punkIndex"].toString();
              let value = args["value"].toString();
              const fromAddress = args["fromAddress"].toLowerCase();
              let toAddress = args["toAddress"].toLowerCase();

              const orderSide = toAddress === AddressZero ? "buy" : "sell";

              // Due to an upstream issue with the Punks contract, the `PunkBought`
              // event is emitted with zeroed `toAddress` and `value` fields when a
              // bid acceptance transaction is triggered. See the following issue:
              // https://github.com/larvalabs/cryptopunks/issues/19

              // To work around this, we get the correct `toAddress` from the most
              // recent `Transfer` event which includes the correct taker
              if (
                cryptopunksTransferEvents.length &&
                cryptopunksTransferEvents[cryptopunksTransferEvents.length - 1].txHash ===
                  baseEventParams.txHash
              ) {
                toAddress = cryptopunksTransferEvents[cryptopunksTransferEvents.length - 1].to;
              }

              // To get the correct price that the bid was settled at we have to
              // parse the transaction's calldata and extract the `minPrice` arg
              // where applicable (if the transaction was a bid acceptance one)
              const tx = await syncEventsUtils.fetchTransaction(baseEventParams.txHash);
              const iface = new Interface([
                "function acceptBidForPunk(uint punkIndex, uint minPrice)",
              ]);
              try {
                const result = iface.decodeFunctionData("acceptBidForPunk", tx.data);
                value = result.minPrice.toString();
              } catch {
                // Skip any errors
              }

              const orderKind = "cryptopunks";
              const maker = orderSide === "sell" ? fromAddress : toAddress;
              let taker = orderSide === "sell" ? toAddress : fromAddress;

              // Handle: attribution
              const data = await syncEventsUtils.extractAttributionData(
                baseEventParams.txHash,
                orderKind
              );
              if (data.taker) {
                taker = data.taker;
              }

              // Handle: prices
              const prices = await getUSDAndNativePrices(
                Sdk.Common.Addresses.Eth[config.chainId],
                value,
                baseEventParams.timestamp
              );
              if (!prices.nativePrice) {
                // We must always have the native price
                break;
              }

              const source = await getOrderSourceByOrderKind(orderKind, baseEventParams.address);
              fillEventsPartial.push({
                orderKind,
                orderSide,
                orderSourceIdInt: source?.id,
                maker,
                taker,
                price: prices.nativePrice,
                usdPrice: prices.usdPrice,
                currency: Sdk.Common.Addresses.Eth[config.chainId],
                contract: baseEventParams.address?.toLowerCase(),
                tokenId: punkIndex,
                amount: "1",
                fillSourceId: data.fillSource?.id,
                aggregatorSourceId: data.aggregatorSource?.id,
                baseEventParams,
              });

              break;
            }

            case "cryptopunks-transfer": {
              const { args } = eventData.abi.parseLog(log);
              const to = args["to"].toLowerCase();

              cryptopunksTransferEvents.push({
                to,
                txHash: baseEventParams.txHash,
              });

              break;
            }
          }
        } catch (error) {
          logger.info("sync-events", `Failed to handle events: ${error}`);
          throw error;
        }
      }

      if (!backfill) {
        // Assign source based on order for each fill.
        await Promise.all([
          assignOrderSourceToFillEvents(fillEvents),
          assignOrderSourceToFillEvents(fillEventsPartial),
          assignOrderSourceToFillEvents(fillEventsFoundation),
        ]);

        await Promise.all([
          assignWashTradingScoreToFillEvents(fillEvents),
          assignWashTradingScoreToFillEvents(fillEventsPartial),
          assignWashTradingScoreToFillEvents(fillEventsFoundation),
        ]);
      } else {
        logger.warn("sync-events", `Skipping assigning orders source assigned to fill events`);
      }

      // --- Handle: mints as sales ---

      for (const [txHash, mints] of tokensMinted.entries()) {
        if (mints.length > 0) {
          const tx = await syncEventsUtils.fetchTransaction(txHash);

          // Skip free mints
          if (tx.value === "0") {
            continue;
          }

          const totalAmount = mints
            .map(({ amount }) => amount)
            .reduce((a, b) => bn(a).add(b).toString());
          const price = bn(tx.value).div(totalAmount).toString();
          const currency = Sdk.Common.Addresses.Eth[config.chainId];

          for (const mint of mints) {
            const prices = await getUSDAndNativePrices(
              currency,
              price,
              mint.baseEventParams.timestamp
            );
            if (!prices.nativePrice) {
              // We must always have the native price
              continue;
            }

            let taker = tx.from;
            const orderKind = "mint";

            // Handle: attribution
            const data = await syncEventsUtils.extractAttributionData(
              mint.baseEventParams.txHash,
              orderKind
            );
            if (data.taker) {
              taker = data.taker;
            }

            const source = await getOrderSourceByOrderKind(orderKind, mint.baseEventParams.address);
            fillEvents.push({
              orderKind,
              orderSide: "sell",
              orderSourceIdInt: source?.id,
              taker,
              maker: mint.from,
              amount: mint.amount,
              currency,
              price: price,
              usdPrice: prices.usdPrice,
              contract: mint.contract,
              tokenId: mint.tokenId,
              fillSourceId: data.fillSource?.id,
              aggregatorSourceId: data.aggregatorSource?.id,
              baseEventParams: mint.baseEventParams,
            });
          }
        }
      }

      // WARNING! Ordering matters (fills should come in front of cancels).
      await Promise.all([
        es.fills.addEvents(fillEvents),
        es.fills.addEventsPartial(fillEventsPartial),
        es.fills.addEventsFoundation(fillEventsFoundation),
      ]);

      if (!options?.skipNonFillWrites) {
        await Promise.all([
          es.nonceCancels.addEvents(nonceCancelEvents, backfill),
          es.bulkCancels.addEvents(bulkCancelEvents, backfill),
          es.cancels.addEvents(cancelEvents),
          es.cancels.addEventsFoundation(cancelEventsFoundation),
          es.ftTransfers.addEvents(ftTransferEvents, backfill),
          es.nftApprovals.addEvents(nftApprovalEvents),
          es.nftTransfers.addEvents(nftTransferEvents, backfill),
        ]);
      }

      if (!backfill) {
        // WARNING! It's very important to guarantee that the previous
        // events are persisted to the database before any of the jobs
        // below are executed. Otherwise, the jobs can potentially use
        // stale data which will cause inconsistencies (eg. orders can
        // have wrong statuses).
        await Promise.all([
          fillUpdates.addToQueue(fillInfos),
          orderUpdatesById.addToQueue(orderInfos),
          orderUpdatesByMaker.addToQueue(makerInfos),
          orderbookOrders.addToQueue(
            foundationOrders.map((info) => ({ kind: "foundation", info }))
          ),
        ]);
      }

      // --- Handle: orphan blocks ---

      if (!backfill && NS.enableReorgCheck) {
        for (const blockData of blocksSet.values()) {
          const block = Number(blockData.split("-")[0]);
          const blockHash = blockData.split("-")[1];

          // Act right away if the current block is a duplicate
          if ((await blocksModel.getBlocks(block)).length > 1) {
            blockCheck.addToQueue(block, blockHash, 10);
            blockCheck.addToQueue(block, blockHash, 30);
          }
        }

        // Put all fetched blocks on a queue for handling block reorgs
        await Promise.all(
          [...blocksSet.values()].map(async (blockData) => {
            const block = Number(blockData.split("-")[0]);
            const blockHash = blockData.split("-")[1];

            return Promise.all([
              blockCheck.addToQueue(block, blockHash, 60),
              blockCheck.addToQueue(block, blockHash, 5 * 60),
              blockCheck.addToQueue(block, blockHash, 10 * 60),
              blockCheck.addToQueue(block, blockHash, 30 * 60),
              blockCheck.addToQueue(block, blockHash, 60 * 60),
            ]);
          })
        );
      }

      // --- Handle: activities ---

      // Add all the fill events to the activity queue
      const fillActivitiesInfo: processActivityEvent.EventInfo[] = _.map(
        _.concat(fillEvents, fillEventsPartial, fillEventsFoundation),
        (event) => {
          let fromAddress = event.maker;
          let toAddress = event.taker;

          if (event.orderSide === "buy") {
            fromAddress = event.taker;
            toAddress = event.maker;
          }

          return {
            kind: processActivityEvent.EventKind.fillEvent,
            data: {
              contract: event.contract,
              tokenId: event.tokenId,
              fromAddress,
              toAddress,
              price: Number(event.price),
              amount: Number(event.amount),
              transactionHash: event.baseEventParams.txHash,
              logIndex: event.baseEventParams.logIndex,
              batchIndex: event.baseEventParams.batchIndex,
              blockHash: event.baseEventParams.blockHash,
              timestamp: event.baseEventParams.timestamp,
              orderId: event.orderId || "",
            },
          };
        }
      );

      if (!_.isEmpty(fillActivitiesInfo)) {
        await processActivityEvent.addToQueue(fillActivitiesInfo);
      }

      // Add all the transfer/mint events to the activity queue
      const transferActivitiesInfo: processActivityEvent.EventInfo[] = _.map(
        nftTransferEvents,
        (event) => ({
          context: [
            processActivityEvent.EventKind.nftTransferEvent,
            event.baseEventParams.txHash,
            event.baseEventParams.logIndex,
            event.baseEventParams.batchIndex,
          ].join(":"),
          kind: processActivityEvent.EventKind.nftTransferEvent,
          data: {
            contract: event.baseEventParams.address,
            tokenId: event.tokenId,
            fromAddress: event.from,
            toAddress: event.to,
            amount: Number(event.amount),
            transactionHash: event.baseEventParams.txHash,
            logIndex: event.baseEventParams.logIndex,
            batchIndex: event.baseEventParams.batchIndex,
            blockHash: event.baseEventParams.blockHash,
            timestamp: event.baseEventParams.timestamp,
          },
        })
      );

      if (!_.isEmpty(transferActivitiesInfo)) {
        await processActivityEvent.addToQueue(transferActivitiesInfo);
      }

      // --- Handle: mints ---

      // We want to get metadata when backfilling as well
      await tokenUpdatesMint.addToQueue(mintInfos);
    });
};

export const unsyncEvents = async (block: number, blockHash: string) => {
  await Promise.all([
    es.fills.removeEvents(block, blockHash),
    es.bulkCancels.removeEvents(block, blockHash),
    es.nonceCancels.removeEvents(block, blockHash),
    es.cancels.removeEvents(block, blockHash),
    es.ftTransfers.removeEvents(block, blockHash),
    es.nftApprovals.removeEvents(block, blockHash),
    es.nftTransfers.removeEvents(block, blockHash),
    removeUnsyncedEventsActivities.addToQueue(blockHash),
  ]);
};

const assignOrderSourceToFillEvents = async (fillEvents: es.fills.Event[]) => {
  try {
    const orderIds = fillEvents.filter((e) => e.orderId !== undefined).map((e) => e.orderId);
    if (orderIds.length) {
      const orders = [];
      const orderIdChunks = _.chunk(orderIds, 100);

      for (const chunk of orderIdChunks) {
        const ordersChunk = await redb.manyOrNone(
          `
            SELECT
              orders.id,
              orders.source_id_int
            FROM orders
            WHERE id IN ($/orderIds:list/)
              AND source_id_int IS NOT NULL
          `,
          { orderIds: chunk }
        );
        orders.push(...ordersChunk);
      }

      if (orders.length) {
        const orderSourceIdByOrderId = new Map<string, number>();
        for (const order of orders) {
          orderSourceIdByOrderId.set(order.id, order.source_id_int);
        }

        fillEvents.forEach((event) => {
          if (event.orderId == undefined) {
            return;
          }

          const orderSourceId = orderSourceIdByOrderId.get(event.orderId!);

          // If the source id exists on the order, use it as the default in the fill event
          if (orderSourceId) {
            logger.info(
              "sync-events",
              `Default source '${orderSourceId}' assigned to fill event: ${JSON.stringify(event)}`
            );

            event.orderSourceIdInt = orderSourceId;
            if (!event.aggregatorSourceId && !event.fillSourceId) {
              event.fillSourceId = orderSourceId;
            }
          }
        });
      }
    }
  } catch (error) {
    logger.error("sync-events", `Failed to assign default sources to fill events: ${error}`);
  }
};

const assignWashTradingScoreToFillEvents = async (fillEvents: es.fills.Event[]) => {
  try {
    const inverseFillEvents: { contract: Buffer; maker: Buffer; taker: Buffer }[] = [];

    const washTradingExcludedContracts = NS.washTradingExcludedContracts;
    const washTradingWhitelistedAddresses = NS.washTradingWhitelistedAddresses;
    const washTradingBlacklistedAddresses = NS.washTradingBlacklistedAddresses;

    // Filter events that don't need to be checked for inverse sales
    const fillEventsPendingInverseCheck = fillEvents.filter(
      (e) =>
        !washTradingExcludedContracts.includes(e.contract) &&
        !washTradingWhitelistedAddresses.includes(e.maker) &&
        !washTradingWhitelistedAddresses.includes(e.taker) &&
        !washTradingBlacklistedAddresses.includes(e.maker) &&
        !washTradingBlacklistedAddresses.includes(e.taker)
    );

    const fillEventsPendingInverseCheckChunks = _.chunk(fillEventsPendingInverseCheck, 100);

    for (const fillEventsChunk of fillEventsPendingInverseCheckChunks) {
      const inverseFillEventsFilter = fillEventsChunk.map(
        (fillEvent) =>
          `('${_.replace(fillEvent.taker, "0x", "\\x")}', '${_.replace(
            fillEvent.maker,
            "0x",
            "\\x"
          )}', '${_.replace(fillEvent.contract, "0x", "\\x")}')`
      );

      const inverseFillEventsChunkQuery = pgp.as.format(
        `
            SELECT DISTINCT contract, maker, taker from fill_events_2
            WHERE (maker, taker, contract) IN ($/inverseFillEventsFilter:raw/)
          `,
        {
          inverseFillEventsFilter: inverseFillEventsFilter.join(","),
        }
      );

      const inverseFillEventsChunk = await redb.manyOrNone(inverseFillEventsChunkQuery);

      inverseFillEvents.push(...inverseFillEventsChunk);
    }

    fillEvents.forEach((event, index) => {
      // Mark event as wash trading for any blacklisted addresses
      let washTradingDetected =
        washTradingBlacklistedAddresses.includes(event.maker) ||
        washTradingBlacklistedAddresses.includes(event.taker);

      if (!washTradingDetected) {
        // Mark event as wash trading if we find a corresponding transfer from taker
        washTradingDetected = inverseFillEvents.some((inverseFillEvent) => {
          return (
            event.maker == fromBuffer(inverseFillEvent.taker) &&
            event.taker == fromBuffer(inverseFillEvent.maker) &&
            event.contract == fromBuffer(inverseFillEvent.contract)
          );
        });
      }

      if (washTradingDetected) {
        logger.info("sync-events", `Wash trading detected. event: ${JSON.stringify(event)}`);
      }

      fillEvents[index].washTradingScore = Number(washTradingDetected);
    });
  } catch (e) {
    logger.error("sync-events", `Failed to assign wash trading score to fill events: ${e}`);
  }
};
