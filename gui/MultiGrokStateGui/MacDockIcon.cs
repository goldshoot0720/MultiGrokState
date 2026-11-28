using System.Runtime.InteropServices;

namespace MultiGrokStateGui;

/// <summary>
/// macOS shows the host executable's icon in the Dock. When the app runs as
/// <c>dotnet Foo.dll</c>, or as a published single-file executable copied away
/// from the source tree, that tile is a generic mark. Replace
/// <c>NSApplication.applicationIconImage</c> with our own artwork.
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
        return ExtractEmbeddedPng();
    }

    /// <summary>
    /// A published single-file executable can sit anywhere, so the Assets folder
    /// may not be next to it. Fall back to the PNG compiled into the assembly
    /// (it is an <c>AvaloniaResource</c>), written out to a temp file because
    /// <c>NSImage initWithContentsOfFile:</c> wants a path.
    /// </summary>
    static string? ExtractEmbeddedPng()
    {
        try
        {
            var uri = new Uri("avares://MultiGrokStateGui/Assets/app-icon.png");
            using var source = Avalonia.Platform.AssetLoader.Open(uri);
            var target = Path.Combine(Path.GetTempPath(), "multigrokstate-app-icon.png");
            using var file = File.Create(target);
            source.CopyTo(file);
            return target;
        }
        catch
        {
            return null;
        }
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
