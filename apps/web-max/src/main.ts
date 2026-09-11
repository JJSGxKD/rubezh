import { createGame } from "@bh/core-game";
import { MaxAdapter } from "@bh/adapter-max";

const adapter = new MaxAdapter();
createGame(adapter, { parent: "game" });
