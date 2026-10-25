/**
 * Settings now lives in SettingsPanel.tsx (home grid + sections) and
 * CrmConfigForm.tsx (the CRM integration section). This module keeps the
 * import path App.tsx and older code use.
 */
export { SettingsPanel, SettingsPanel as CRMSettingsModal } from './SettingsPanel';
export type { SettingsTab, SectionCard } from './SettingsPanel';
export type { CRMConfig } from './CrmConfigForm';
