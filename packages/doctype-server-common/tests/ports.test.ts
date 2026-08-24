import { runPortContract } from "../src/testing/port-contract.js";
import { createMemoryPorts } from "../src/memory-ports.js";

// `transactional: true` — the in-memory MemoryUnitOfWork implements a real
// rollback (snapshot the port state on entry, restore it if the callback
// throws), so it must satisfy the contract's two transaction assertions.
runPortContract("memory ports", async () => createMemoryPorts(), {
  transactional: true,
  // In-memory ports have no connection pool; two promises interleave
  // directly, so there is nothing to warm up.
  prepareConcurrency: async () => ({
    concurrentWriters: 2,
    how: "in-memory ports have no connection pool; two promises interleave directly",
  }),
});
