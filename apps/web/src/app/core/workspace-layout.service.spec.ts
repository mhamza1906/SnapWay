import { WorkspaceLayout } from './workspace-layout.service';
describe('Workspace panel coordination', () => {
  it('hides navigation at the combined 45 percent threshold and permits manual reopening', () => {
    const layout = new WorkspaceLayout();
    layout.sidebarOpen.set(true);
    layout.openAI(1000);
    expect(layout.aiOpen()).toBe(true);
    expect(layout.sidebarOpen()).toBe(false);
    layout.toggleSidebar();
    expect(layout.sidebarOpen()).toBe(true);
  });
  it('keeps both panels when sufficient room remains', () => {
    const layout = new WorkspaceLayout();
    layout.sidebarOpen.set(true);
    layout.openAI(1700);
    expect(layout.sidebarOpen()).toBe(true);
  });
});
