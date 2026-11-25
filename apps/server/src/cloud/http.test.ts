import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentHttpApi, AuthStandardClientScopes, AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ConnectHttp from "./http.ts";
import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

class RetiredAccountApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.connect,
) {}

const layerRoutes = HttpApiBuilder.layer(RetiredAccountApi).pipe(
  Layer.provide(ConnectHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      authenticateHttpRequest: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("test"),
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          scopes: AuthStandardClientScopes,
        }),
    }),
  ),
  Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "refuses cloud account registration and credentials without loading a cloud service",
  () =>
    Effect.gen(function* () {
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
        (web) => Effect.promise(() => web.dispose()),
      );
      for (const [method, path] of [
        ["GET", "/api/connect/link-state"],
        ["POST", "/api/connect/reachability"],
      ] as const) {
        const response = yield* Effect.promise(() =>
          web.handler(
            new Request(`http://localhost${path}`, {
              method,
              headers: { authorization: "Bearer stale-account-token" },
            }),
            Context.empty(),
          ),
        );
        expect(response.status).toBe(403);
      }
    }).pipe(Effect.scoped),
);
