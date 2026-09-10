// Wrangler compiles this import at build time into a WebAssembly.Module.
//
// It has to be a module rather than raw bytes: the Workers runtime refuses
// runtime compilation outright ("Wasm code generation disallowed by embedder"),
// so WebAssembly.compile/instantiate over an ArrayBuffer throws in production
// however the encoder library is loaded.
import wasm from "../vendor/ogg.wasm";

export default wasm;
