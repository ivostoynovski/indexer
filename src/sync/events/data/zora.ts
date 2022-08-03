import { Interface } from "@ethersproject/abi";
import { Zora } from "@reservoir0x/sdk";
import { config } from "@/config/index";
import { EventData } from "@/events-sync/data";

export const askFilled: EventData = {
  kind: "zora-ask-filled",
  addresses: { [Zora.Addresses.Exchange[config.chainId]]: true },
  topic: "0xed509339c949cdfdb11c117315bb3f74aa98886204732c065edd38979d7ccf53",
  numTopics: 3,
  abi: new Interface([
    `event AskFilled(
      address indexed tokenContract,
      uint256 indexed tokenId,
      address buyer,
      address seller,
      uint256 price
      )`,
  ]),
};
