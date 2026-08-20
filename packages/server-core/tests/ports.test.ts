import { runPortContract } from "../src/testing/port-contract.js";
import { createMemoryPorts } from "../src/memory-ports.js";

runPortContract("memory ports", async () => createMemoryPorts());
