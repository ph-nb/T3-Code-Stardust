import sliderScript from "@t3tools/mobile-starship-slider";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { useAppForeground, useReduceMotionEnabled } from "../../lib/appState";
import { AppText as Text } from "../ui/AppText";
import {
  starshipSliderDocument,
  starshipSliderSelection,
  type StarshipSliderConfiguration,
} from "./starship-slider-document";

const source = { html: starshipSliderDocument(sliderScript) };

export function StarshipEffortSlider(props: {
  readonly label: string;
  readonly options: StarshipSliderConfiguration["options"];
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const webview = useRef<WebView<object>>(null);
  const reducedMotion = useReduceMotionEnabled();
  const active = useAppForeground();
  const selectedIndex = Math.max(
    0,
    props.options.findIndex((option) => option.id === props.value),
  );
  const valueLabel = props.options[selectedIndex]?.label ?? props.value;
  const configuration = JSON.stringify({
    options: props.options,
    value: props.value,
    reducedMotion,
    active,
    disabled: props.disabled === true,
  } satisfies StarshipSliderConfiguration);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes native selection and lifecycle with the local canvas document.
  useEffect(() => {
    webview.current?.injectJavaScript(`StardustSlider.update(${configuration});true;`);
  }, [configuration]);

  const commit = (value: string | undefined) => {
    if (!value || props.disabled || value === props.value) return;
    if (!reducedMotion) void Haptics.selectionAsync();
    props.onChange(value);
  };
  return (
    <View className="gap-2 p-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
        <Text className="text-xs text-foreground-muted">{valueLabel}</Text>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.label}
        accessibilityValue={{
          min: 0,
          max: Math.max(0, props.options.length - 1),
          now: selectedIndex,
          text: valueLabel,
        }}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          const offset =
            nativeEvent.actionName === "increment"
              ? 1
              : nativeEvent.actionName === "decrement"
                ? -1
                : 0;
          commit(
            props.options[Math.max(0, Math.min(props.options.length - 1, selectedIndex + offset))]
              ?.id,
          );
        }}
        style={{ height: 56, opacity: props.disabled ? 0.45 : 1 }}
      >
        <WebView<object>
          ref={webview}
          source={source}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          originWhitelist={["about:blank"]}
          onShouldStartLoadWithRequest={({ url }) => url === "about:blank"}
          onLoadEnd={() =>
            webview.current?.injectJavaScript(`StardustSlider.update(${configuration});true;`)
          }
          onMessage={({ nativeEvent }) =>
            commit(starshipSliderSelection(nativeEvent.data, props.options) ?? undefined)
          }
          scrollEnabled={false}
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          style={{ backgroundColor: "transparent" }}
        />
      </View>
      <View
        className="flex-row justify-between gap-2"
        importantForAccessibility="no-hide-descendants"
      >
        {props.options.map((option) => (
          <Text
            key={option.id}
            className="flex-1 text-center text-xs text-foreground-muted"
            numberOfLines={1}
          >
            {option.label}
          </Text>
        ))}
      </View>
    </View>
  );
}
