import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setOggWasm } from "../src/ogg.js";

// Node may compile WebAssembly from bytes; the Workers runtime may not, which
// is why production imports a module bundled at build time instead.
setOggWasm(readFileSync(fileURLToPath(new URL("../vendor/ogg.wasm", import.meta.url))));
