import { SettingsScreen } from "./components/SettingsScreen";
import { useGT } from "gt-react-native";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  return (
    <SettingsScreen title={gt("Notifications")}>
      <View className="p-4">
        <AppText>{gt("Notifications are not available in this build.")}</AppText>
      </View>
    </SettingsScreen>
  );
}
