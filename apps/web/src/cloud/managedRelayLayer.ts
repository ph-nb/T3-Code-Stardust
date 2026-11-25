import { DpopProof } from "@t3tools/client-runtime/relay";
import { loadOrCreateProofKey } from "./dpop";

export const layer = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});
