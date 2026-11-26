' Start Queue Print Agent in the background (no window).
' Used by the Startup entry and the Start-menu / desktop shortcuts.
' To see its messages, use the "แสดงหน้าต่าง" shortcut instead (stop this one first).
Set fso = CreateObject("Scripting.FileSystemObject")
exe = fso.GetParentFolderName(WScript.ScriptFullName) & "\QueuePrintAgent.exe"
CreateObject("WScript.Shell").Run """" & exe & """", 0, False
