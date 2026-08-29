export {
  PermissionGate,
  allowAllPermissionPolicy,
  denyByDefaultPermissionPrompter,
} from "./permission-gate.ts";
export { PermissionModePolicy } from "./permission-mode-policy.ts";
export { PathBoundary } from "./path-boundary.ts";
export {
  PermissionRulePolicy,
  validatePermissionRules,
} from "./permission-rule-policy.ts";
export {
  ProjectTrustStore,
  resolveProjectTrustRoot,
} from "./project-trust.ts";
export {
  addLocalPermissionAllowRule,
  loadPermissionSettings,
} from "./permission-settings.ts";

export type {
  FilesystemAccess,
  FilesystemAccessPlan,
  FilesystemOperation,
  PermissionAuthorization,
  PermissionDecision,
  PermissionGrantProposal,
  PermissionKind,
  PermissionMode,
  PermissionPolicy,
  PermissionPromptResult,
  PermissionPrompter,
  PermissionRequest,
  ShellCommandSemantics,
  ToolPermissionDescriptor,
} from "./types.ts";

export type {
  PathBoundaryAssessment,
  ResolvedFilesystemAccess,
} from "./path-boundary.ts";

export type {
  ProjectTrustRoot,
  ProjectTrustStatus,
} from "./project-trust.ts";

export type {
  LoadPermissionSettingsOptions,
  LoadedPermissionSettings,
  PermissionRuleSetting,
  PermissionSettingSource,
  TrustGatedPermissionSettings,
} from "./permission-settings.ts";
