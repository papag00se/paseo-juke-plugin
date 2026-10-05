import type { PluginClientContext } from "@getpaseo/plugin/client";
import { JukeSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "settings", title: "Settings", icon: "Settings", Component: JukeSettings });
  client.addCommandCenterItem({ id: "settings", title: "Juke settings", icon: "Settings", context: "global", onSelect: ({ openSettings }) => openSettings("settings") });
  return () => {};
}
