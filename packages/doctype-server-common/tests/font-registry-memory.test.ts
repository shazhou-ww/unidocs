import { runFontRegistryContract } from "../src/testing/font-registry-contract.js";
import { createMemoryFontRegistry } from "../src/memory-ports.js";

runFontRegistryContract("MemoryFontRegistry", async () => createMemoryFontRegistry());
