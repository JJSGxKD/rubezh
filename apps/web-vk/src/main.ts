import { createGame } from "@bh/core-game";
import { VkAdapter } from "@bh/adapter-vk";

const adapter = new VkAdapter();
createGame(adapter, "game");
