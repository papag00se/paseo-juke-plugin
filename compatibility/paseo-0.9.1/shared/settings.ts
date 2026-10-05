import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "juke", scope: "host", version: 1,
  schema: z.object({ enabled: z.boolean().default(true) }),
});
