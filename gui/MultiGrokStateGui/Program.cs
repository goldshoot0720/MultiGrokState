using Avalonia;
using System;

namespace MultiGrokStateGui;

sealed class Program
{
    // Initialization code. Don't use any Avalonia, third-party APIs or any
    // SynchronizationContext-reliant code before AppMain is called: things aren't initialized
    // yet and stuff might break.
    [STAThread]
    public static void Main(string[] args)
    {
        if (OperatingSystem.IsMacOS())
        {
            // Finder launches apps without the shell's Node and npm bin paths.
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var path = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries);
            var commonBins = new[] { Path.Combine(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin" };
            Environment.SetEnvironmentVariable("PATH", string.Join(':', path.Union(commonBins)));
        }
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    // Avalonia configuration, don't remove; also used by visual designer.
    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
