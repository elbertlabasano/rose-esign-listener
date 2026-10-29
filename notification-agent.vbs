Option Explicit
Dim files, shell, folder, nodePath, command, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = files.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count <> 1 Then
  WScript.Quit 2
End If
nodePath = WScript.Arguments(0)
shell.CurrentDirectory = folder
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & folder & "\notification-agent.js" & Chr(34)
' Hidden window; wait so Task Scheduler can track exit/failure and restart it.
result = shell.Run(command, 0, True)
WScript.Quit result
