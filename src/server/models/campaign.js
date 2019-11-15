import thinky from "./thinky";
const type = thinky.type;
import { requiredString, optionalString, timestamp } from "./custom-types";

import Organization from "./organization";

const Campaign = thinky.createModel(
  "campaign",
  type
    .object()
    .schema({
      id: type.string(),
      organization_id: requiredString(),
      creator_id: type.string().allowNull(true),
      title: optionalString(),
      description: optionalString(),
      is_started: type.boolean().required(),
      due_by: type
        .date()
        .required()
        .default(null),
      created_at: timestamp(),
      is_archived: type.boolean().required(),
      use_dynamic_assignment: type.boolean().required(),
      logo_image_url: type.string(),
      intro_html: type.string(),
      primary_color: type.string(),
      texting_hours_start: type
        .number()
        .integer()
        .required()
        .min(0)
        .max(23)
        .default(9),
      texting_hours_end: type
        .number()
        .integer()
        .required()
        .min(0)
        .max(23)
        .default(21),
      is_autoassign_enabled: type.boolean().required(),
      timezone: type.string()
    })
    .allowExtra(false),
  { noAutoCreation: true }
);

Campaign.ensureIndex("organization_id");
Campaign.ensureIndex("creator_id");

export default Campaign;
