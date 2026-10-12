using System.Text.Json.Serialization;

namespace MultiGrokStateGui.Models;

/// <summary>
/// JSON model for <c>MultiGrokState usage --json</c> output.
/// </summary>
public class UsageInfo
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("creditUsagePercent")]
    public double? CreditUsagePercent { get; set; }

    [JsonPropertyName("limit")]
    public double? Limit { get; set; }

    [JsonPropertyName("used")]
    public double? Used { get; set; }

    [JsonPropertyName("periodType")]
    public string? PeriodType { get; set; }

    [JsonPropertyName("periodEnd")]
    public string? PeriodEnd { get; set; }

    [JsonPropertyName("monthly")]
    public MonthlyUsageInfo? Monthly { get; set; }

    [JsonPropertyName("productUsage")]
    public Dictionary<string, double>? ProductUsage { get; set; }

    [JsonPropertyName("prepaidBalance")]
    public double? PrepaidBalance { get; set; }

    [JsonPropertyName("noCapReported")]
    public bool NoCapReported { get; set; }
}

public class MonthlyUsageInfo
{
    [JsonPropertyName("creditUsagePercent")]
    public double? CreditUsagePercent { get; set; }

    [JsonPropertyName("limit")]
    public double? Limit { get; set; }

    [JsonPropertyName("used")]
    public double? Used { get; set; }

    [JsonPropertyName("periodEnd")]
    public string? PeriodEnd { get; set; }
}
