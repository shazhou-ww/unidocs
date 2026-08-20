import { runPortContract } from "../src/port-contract.js";
import { createMemoryPorts } from "../src/memory-ports.js";

runPortContract("memory ports", async () => createMemoryPorts());
