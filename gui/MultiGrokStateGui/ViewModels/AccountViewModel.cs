using System.Text;
using Avalonia.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using MultiGrokStateGui.Models;

namespace MultiGrokStateGui.ViewModels;

/// <summary>
/// Per-account display item that merges <see cref="AccountInfo"/> and
/// <see cref="UsageInfo"/> into observable, UI-friendly properties.
/// </summary>
public partial class AccountViewModel : ObservableObject
{
    // ── Raw identity ────────────────────────────────────────────────

    [ObservableProperty]
    private string? _name;

    [ObservableProperty]
    private string? _email;

    [ObservableProperty]
    private string? _displayName;

    // ── Token status ────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusColor))]
    private string? _status = "unknown";

    [ObservableProperty]
    private bool _isActive;

    [ObservableProperty]
    private long? _expiresAt;

    // ── Weekly usage ────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PercentText))]
    [NotifyPropertyChangedFor(nameof(PercentValue))]
    [NotifyPropertyChangedFor(nameof(BarColor))]
    private double? _weeklyPercent;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AllowanceText))]
    private double? _limit;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AllowanceText))]
    private double? _used;

    // ── Monthly usage ───────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasMonthly))]
    [NotifyPropertyChangedFor(nameof(MonthlyPercentText))]
    [NotifyPropertyChangedFor(nameof(MonthlyAllowanceText))]
    private double? _monthlyPercent;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasMonthly))]
    [NotifyPropertyChangedFor(nameof(MonthlyAllowanceText))]
    private double? _monthlyLimit;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasMonthly))]
    [NotifyPropertyChangedFor(nameof(MonthlyAllowanceText))]
    private double? _monthlyUsed;

    // ── Period / state ──────────────────────────────────────────────

    [ObservableProperty]
    private string? _periodType;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ResetText))]
    private string? _periodEnd;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string? _error;

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PercentText))]
    private bool _hasUsage;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UsageNote))]
    [NotifyPropertyChangedFor(nameof(HasUsageNote))]
    private bool _noCapReported;

    [ObservableProperty]
    private double? _prepaidBalance;

    // ── Cached brushes (avoid allocating on every property access) ──

    private static readonly IBrush BrushGreen = new SolidColorBrush(Color.FromRgb(0x22, 0xC5, 0x5E));
    private static readonly IBrush BrushYellow = new SolidColorBrush(Color.FromRgb(0xEA, 0xB3, 0x08));
    private static readonly IBrush BrushRed = new SolidColorBrush(Color.FromRgb(0xEF, 0x44, 0x44));
    private static readonly IBrush BrushGray = new SolidColorBrush(Color.FromRgb(0x9C, 0xA3, 0xAF));

    // ── Derived display properties ─────────────────────────────────

    public IBrush StatusColor => Status switch
    {
        "valid" => BrushGreen,
        "expiring" => BrushYellow,
        "expired" => BrushRed,
        "invalid" => BrushRed,
        _ => BrushGray,
    };

    /// <summary>
    /// A plan with no reported allowance renders "0.0%" (like the Grok CLI),
    /// never a blank dash, so the bar never looks broken.
    /// </summary>
    public string PercentText
    {
        get
        {
            if (WeeklyPercent.HasValue) return $"{WeeklyPercent:F1}%";
            if (HasUsage) return "0.0%";
            return "\u2014";
        }
    }

    public double PercentValue => WeeklyPercent ?? 0;

    public IBrush BarColor => WeeklyPercent switch
    {
        >= 90 => BrushRed,
        >= 70 => BrushYellow,
        _ => BrushGreen,
    };

    public string? MonthlyPercentText =>
        MonthlyPercent.HasValue ? $"{MonthlyPercent:F1}%" : null;

    public bool HasMonthly =>
        MonthlyPercent.HasValue || MonthlyLimit.HasValue || MonthlyUsed.HasValue;

    public string MonthlyAllowanceText
    {
        get
        {
            if (!HasMonthly) return string.Empty;
            if (MonthlyLimit == null || MonthlyLimit == 0)
            {
                return MonthlyUsed.HasValue ? $"used {MonthlyUsed:0.##}" : string.Empty;
            }
            return $"{MonthlyUsed ?? 0} / {MonthlyLimit}";
        }
    }

    public string ResetText
    {
        get
        {
            if (string.IsNullOrWhiteSpace(PeriodEnd)) return string.Empty;
            if (DateTimeOffset.TryParse(PeriodEnd, out var dto))
            {
                var local = dto.ToLocalTime();
                var remaining = local - DateTimeOffset.Now;
                if (remaining <= TimeSpan.Zero) return "resets now";

                var sb = new StringBuilder("Resets: ");
                sb.Append(local.ToString("MMM d, HH:mm"));

                if (remaining.TotalDays >= 1)
                    sb.Append($" (in {(int)remaining.TotalDays}d {remaining.Hours}h)");
                else if (remaining.TotalHours >= 1)
                    sb.Append($" (in {remaining.Hours}h {remaining.Minutes}m)");
                else
                    sb.Append($" (in {remaining.Minutes}m)");

                return sb.ToString();
            }
            return string.Empty;
        }
    }

    public bool HasError => !string.IsNullOrWhiteSpace(Error);

    public string AllowanceText
    {
        get
        {
            if (Limit == null && Used == null) return string.Empty;
            var used = Used ?? 0;
            if (Limit == null || Limit == 0) return $"used {used} \u00B7 no cap";
            return $"{used} / {Limit}";
        }
    }

    public string UsageNote =>
        NoCapReported ? "plan reports no usage for this window (bar shown at 0%)" : string.Empty;

    public bool HasUsageNote => NoCapReported;

    // ── Update from CLI JSON models ─────────────────────────────────

    public void ApplyAccount(AccountInfo info)
    {
        Name = info.Name;
        Email = info.Email;
        DisplayName = info.DisplayName;
        Status = info.Status ?? "unknown";
        IsActive = info.IsActive;
        ExpiresAt = info.ExpiresAt;
    }

    public void ApplyUsage(UsageInfo info)
    {
        if (!info.Ok)
        {
            Error = info.Error ?? "unknown error";
            HasUsage = false;
            return;
        }

        Error = null;
        HasUsage = true;
        WeeklyPercent = info.CreditUsagePercent;
        PeriodType = info.PeriodType;
        PeriodEnd = info.PeriodEnd;
        Limit = info.Limit;
        Used = info.Used;
        NoCapReported = info.NoCapReported;
        PrepaidBalance = info.PrepaidBalance;

        if (info.Monthly != null)
        {
            MonthlyPercent = info.Monthly.CreditUsagePercent;
            MonthlyLimit = info.Monthly.Limit;
            MonthlyUsed = info.Monthly.Used;
        }
    }
}
