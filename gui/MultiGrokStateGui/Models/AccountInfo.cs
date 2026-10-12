using System.Text.Json.Serialization;

namespace MultiGrokStateGui.Models;

/// <summary>
/// JSON model for <c>MultiGrokState list --json</c> output.
/// </summary>
public class AccountInfo
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("displayName")]
    public string? DisplayName { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("expiresAt")]
    public long? ExpiresAt { get; set; }

    [JsonPropertyName("isActive")]
    public bool IsActive { get; set; }
}
