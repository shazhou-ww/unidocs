import { runFontProviderContract } from "../src/testing/font-provider-contract.js";
import { createMemoryFontProvider } from "../src/memory-ports.js";

runFontProviderContract("MemoryFontProvider", async () => createMemoryFontProvider());
