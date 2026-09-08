import { createGame } from "@bh/core-game";
import { TelegramAdapter } from "@bh/adapter-telegram";

const adapter = new TelegramAdapter();
createGame(adapter, "game");
