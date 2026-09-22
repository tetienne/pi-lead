/** Trusted host-side presentation adapter. It never enters a worker VM. */
export interface HerdrClient {
  createBackgroundTab(request: {
    workspaceId: string;
    cwd: string;
    label: string;
    focus: false;
  }): Promise<{ tabId: string; paneId: string }>;
  tabExists(tabId: string): Promise<boolean>;
  closeTab(tabId: string): Promise<void>;
}
