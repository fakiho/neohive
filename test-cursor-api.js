// Test script to check Cursor's VSCode API compatibility
const vscode = require('vscode');

function testCursorApi() {
  console.log('=== Cursor VSCode API Test ===');
  
  // 1. Check vscode.env.appName
  console.log('1. vscode.env.appName:', vscode.env.appName);
  
  // 2. Check if status bar creation works
  try {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.text = 'Test';
    statusBar.show();
    console.log('2. Status bar creation: SUCCESS');
    statusBar.dispose();
  } catch (e) {
    console.log('2. Status bar creation: FAILED -', e.message);
  }
  
  // 3. Check notifications
  try {
    vscode.window.showInformationMessage('Cursor API test notification');
    console.log('3. Notification API: SUCCESS');
  } catch (e) {
    console.log('3. Notification API: FAILED -', e.message);
  }
  
  // 4. Check workspace folders
  console.log('4. Workspace folders:', vscode.workspace.workspaceFolders?.length || 0);
  
  // 5. Check configuration API
  try {
    const config = vscode.workspace.getConfiguration('neohive');
    console.log('5. Configuration API: SUCCESS');
  } catch (e) {
    console.log('5. Configuration API: FAILED -', e.message);
  }
}

// This would normally be called in extension activation
testCursorApi();