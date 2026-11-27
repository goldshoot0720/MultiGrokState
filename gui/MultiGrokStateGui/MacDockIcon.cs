using System.Runtime.InteropServices;

namespace MultiGrokStateGui;

/// <summary>
/// macOS shows the host executable's icon in the Dock. This process is
/// <c>dotnet</c>, so the tile stays the generic "exec" mark unless we replace
/// <c>NSApplication.applicationIconImage</c> ourselves.
/// </summary>
static class MacDockIcon
{
    public static void Apply()
    {
        if (!OperatingSystem.IsMacOS()) return;

        var path = ResolvePng();
        if (path == null) return;

        var sharedApp = Send(GetClass("NSApplication"), Sel("sharedApplication"));
        var image = Send(Send(GetClass("NSImage"), Sel("alloc")), Sel("initWithContentsOfFile:"), NsString(path));
        if (sharedApp == IntPtr.Zero || image == IntPtr.Zero) return;

        Send(sharedApp, Sel("setApplicationIconImage:"), image);
    }

    static string? ResolvePng()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "Assets", "app-icon.png");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    static IntPtr NsString(string value)
    {
        return SendUtf8(Send(GetClass("NSString"), Sel("alloc")), Sel("initWithUTF8String:"), value);
    }

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_getClass")]
    static extern IntPtr GetClass(string name);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "sel_registerName")]
    static extern IntPtr Sel(string name);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    static extern IntPtr Send(IntPtr receiver, IntPtr selector);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    static extern IntPtr Send(IntPtr receiver, IntPtr selector, IntPtr arg);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    static extern IntPtr SendUtf8(
        IntPtr receiver,
        IntPtr selector,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string arg);
}
