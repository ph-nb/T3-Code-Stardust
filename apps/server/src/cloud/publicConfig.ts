import * as Config from "effect/Config";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

export const hasCloudPublicConfig = false;
export const hostedAppUrlConfig = Config.String("T3CODE_HOSTED_APP_URL").pipe(
  Config.withDefault(DEFAULT_HOSTED_APP_URL),
);
