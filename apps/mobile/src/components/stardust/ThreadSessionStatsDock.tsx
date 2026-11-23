import { selectSessionStats } from "@t3tools/client-runtime/sessionStats";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { AppText as Text } from "../ui/AppText";
import { Sheet } from "../ui/Sheet";

function StatCard(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="min-w-0 flex-1 gap-2 rounded-2xl bg-grouped-card p-4">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="text-2xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
    </View>
  );
}

export function ThreadSessionStatsDock(props: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const projection = useQuietThreadStructure(props.threadRef);
  const [open, setOpen] = useState<"session" | "tokens" | null>(null);
  if (!projection) return null;
  const stats = selectSessionStats(projection.projection);
  const sessionTitle = gt("Session overview");
  const tokensTitle = gt("Tokens & cache");
  const duration = (value: number) => gt("{seconds}s", { seconds: Math.round(value / 1000) });
  const tokenCount = (value: number | null) =>
    value === null ? gt("Not reported") : formatTokens(value);
  const modelShare =
    stats.modelMs + stats.toolMs === 0 ? 0 : stats.modelMs / (stats.modelMs + stats.toolMs);

  return (
    <View className="items-center">
      <View className="w-full flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sessionTitle}
          accessibilityState={{ expanded: open === "session" }}
          onPress={() => setOpen("session")}
          className="min-h-11 min-w-0 flex-1 items-center justify-center rounded-full px-3 active:bg-subtle"
        >
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {sessionTitle} · {stats.turns}/{stats.steps}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tokensTitle}
          accessibilityState={{ expanded: open === "tokens" }}
          onPress={() => setOpen("tokens")}
          className="min-h-11 min-w-0 flex-1 items-center justify-center rounded-full px-3 active:bg-subtle"
        >
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {tokensTitle} · {tokenCount(stats.inputTokens)}
          </Text>
        </Pressable>
      </View>
      {open ? (
        <Sheet
          title={open === "session" ? sessionTitle : tokensTitle}
          onClose={() => setOpen(null)}
        >
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 20, paddingBottom: 44, gap: 12 }}
          >
            {open === "session" ? (
              <>
                <View className="flex-row gap-3">
                  <StatCard
                    label={gt("Rounds & steps")}
                    value={`${stats.turns} / ${stats.steps}`}
                  />
                  <StatCard
                    label={gt("Output speed")}
                    value={
                      stats.outputRate === null
                        ? gt("Not reported")
                        : gt("{rate} tok/s", { rate: Math.round(stats.outputRate) })
                    }
                  />
                </View>
                <View className="flex-row gap-3">
                  <StatCard
                    label={gt("Model time")}
                    value={stats.timedTurns ? duration(stats.modelMs) : gt("Not reported")}
                  />
                  <StatCard
                    label={gt("Tool time")}
                    value={stats.timedTurns ? duration(stats.toolMs) : gt("Not reported")}
                  />
                </View>
                {stats.timedTurns ? (
                  <View
                    className="h-2 flex-row overflow-hidden rounded-full bg-subtle"
                    accessible={false}
                  >
                    <View className="h-2 bg-primary" style={{ width: `${modelShare * 100}%` }} />
                    <View className="h-2 flex-1 bg-foreground-muted" />
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <View className="flex-row gap-3">
                  <StatCard label={gt("Input tokens")} value={tokenCount(stats.inputTokens)} />
                  <StatCard label={gt("Output tokens")} value={tokenCount(stats.outputTokens)} />
                </View>
                <View className="flex-row gap-3">
                  <StatCard
                    label={gt("Cached input")}
                    value={tokenCount(stats.cachedInputTokens)}
                  />
                  <StatCard
                    label={gt("Input cache hit rate")}
                    value={
                      stats.cacheHitRate === null
                        ? gt("Not reported")
                        : formatPercent(stats.cacheHitRate)
                    }
                  />
                </View>
              </>
            )}
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
