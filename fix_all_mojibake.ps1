# Script to fix all UTF-8 mojibake and encoding artifacts across apex-velo-lab

function Fix-File([string]$path, [scriptblock]$transform) {
    $content = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $newContent = & $transform $content
    [System.IO.File]::WriteAllText($path, $newContent, (New-Object System.Text.UTF8Encoding($false)))
    [System.Console]::WriteLine("Fixed: " + $path)
}

# 1. Fix index.html
Fix-File "index.html" {
    param($text)
    
    # Bullet â€¢
    $text = $text.Replace([char]0x00e2 + [char]0x20ac + [char]0x00a2, "&bull;")
    
    # En-dash / Em-dash
    $text = $text.Replace([char]0x00e2 + [char]0x20ac + [char]0x2014, " - ")
    $text = $text.Replace([char]0x00e2 + [char]0x20ac + [char]0x2013, " - ")
    $text = $text.Replace("â€”", " - ")
    $text = $text.Replace("â€“", " - ")
    
    # Degree Â°
    $text = $text.Replace("360Â°", "360&deg;")
    $text = $text.Replace("000Â°", "000&deg;")
    $text = $text.Replace("15Â°", "15&deg;")
    $text = $text.Replace("165Â°", "165&deg;")
    $text = $text.Replace("88Â°", "88&deg;")
    $text = $text.Replace("92Â°", "92&deg;")
    $text = $text.Replace("0Â°", "0&deg;")
    $text = $text.Replace("180Â°", "180&deg;")
    $text = $text.Replace([char]0x00c2 + [char]0x00b0, "&deg;")
    
    # Plus-minus Â±
    $text = $text.Replace("Â±", "&plusmn;")
    $text = $text.Replace([char]0x00c2 + [char]0x00b1, "&plusmn;")
    
    # Registered trademark Â®
    $text = $text.Replace("IFÂ®", "IF&reg;")
    $text = $text.Replace("TSSÂ®", "TSS&reg;")
    $text = $text.Replace("NPÂ®", "NP&reg;")
    $text = $text.Replace([char]0x00c2 + [char]0x00ae, "&reg;")
    
    # Arrows and key badges
    $text = $text.Replace("â†", "&larr;")
    $text = $text.Replace("â†’", "&rarr;")
    $text = $text.Replace("â†‘", "&uarr;")
    $text = $text.Replace("â†“", "&darr;")
    $text = $text.Replace([char]0x00e2 + [char]0x2020 + [char]0x0090, "&larr;")
    $text = $text.Replace([char]0x00e2 + [char]0x2020 + [char]0x2019, "&rarr;")
    $text = $text.Replace([char]0x00e2 + [char]0x2020 + [char]0x2018, "&uarr;")
    $text = $text.Replace([char]0x00e2 + [char]0x2020 + [char]0x201c, "&darr;")
    
    # Icons and buttons
    $text = $text.Replace("âš¡", "&#9889;")
    $text = $text.Replace("â˜…", "&#9733;")
    $text = $text.Replace("âœ•", "&times;")
    $text = $text.Replace("âœï¸", "&#9998;")
    $text = $text.Replace("âœï¸ ", "&#9998;")
    $text = $text.Replace("ðŸ‘¤", "&#128100;")
    $text = $text.Replace("ðŸ”Ž", "&#128065;")
    $text = $text.Replace("âž•", "+")
    $text = $text.Replace("â‡…", "&#8645;")
    $text = $text.Replace("â–¼", "&darr;")
    $text = $text.Replace("â–²", "&uarr;")
    
    # Calendar buttons
    $text = $text.Replace("â—€ Prev", "&larr; Prev")
    $text = $text.Replace("Next â–¶", "Next &rarr;")
    
    return $text
}

# 2. Fix js/velo-workouts.js
Fix-File "js\velo-workouts.js" {
    param($text)
    $text = $text.Replace(" â€” ", " - ")
    $text = $text.Replace("â€”", " - ")
    $text = $text.Replace("â€“", " - ")
    $text = $text.Replace("RÃ¸nnestad", "R\u00f8nnestad")
    $text = $text.Replace("PavÃ©", "Pav\u00e9")
    $text = $text.Replace([char]0x00c3 + [char]0x00b8, "\u00f8")
    $text = $text.Replace([char]0x00c3 + [char]0x00a9, "\u00e9")
    return $text
}

# 3. Fix js/velo-pip.js
Fix-File "js\velo-pip.js" {
    param($text)
    $text = $text.Replace("âš¡ ", "")
    $text = $text.Replace("ðŸ“  ", "")
    return $text
}

# 4. Fix js/velo-biomech.js
Fix-File "js\velo-biomech.js" {
    param($text)
    $text = $text.Replace("Â°", "\u00b0")
    $text = $text.Replace([char]0x00c2 + [char]0x00b0, "\u00b0")
    return $text
}

# 5. Fix js/velo-folder-sync.js
Fix-File "js\velo-folder-sync.js" {
    param($text)
    $text = $text.Replace("â—  ", "\u25cf ")
    $text = $text.Replace("â€”", " - ")
    $text = $text.Replace("âœ“ ", "\u2713 ")
    return $text
}

# 6. Fix js/velo-ai-architect.js
Fix-File "js\velo-ai-architect.js" {
    param($text)
    $text = $text.Replace("RÃ¸nnestad", "R\u00f8nnestad")
    $text = $text.Replace([char]0x00c3 + [char]0x00b8, "\u00f8")
    return $text
}

# 7. Fix js/app.js
Fix-File "js\app.js" {
    param($text)
    
    # Bullet â€¢
    $text = $text.Replace([char]0x00e2 + [char]0x20ac + [char]0x00a2, " \u2022 ")
    
    # Em-dash / En-dash
    $text = $text.Replace(" â€” ", " - ")
    $text = $text.Replace("â€”", " - ")
    $text = $text.Replace("â€“", " - ")
    
    # Checkmark âœ“
    $text = $text.Replace("âœ“ ", "\u2713 ")
    $text = $text.Replace("âœ“", "\u2713")
    
    # Degree Â°
    $text = $text.Replace("Â°", "\u00b0")
    $text = $text.Replace([char]0x00c2 + [char]0x00b0, "\u00b0")
    
    # Plus-minus Â±
    $text = $text.Replace("Â±", "\u00b1")
    $text = $text.Replace([char]0x00c2 + [char]0x00b1, "\u00b1")
    
    # Dot â— 
    $text = $text.Replace("â—  ", "\u25cf ")
    
    # Star â˜…
    $text = $text.Replace("â˜… ", "\u2605 ")
    $text = $text.Replace("â˜…", "\u2605")
    
    # Close / Delete âœ•
    $text = $text.Replace("âœ•", "\u2715")
    
    # Profile & settings emojis
    $text = $text.Replace("ðŸ‘¤  ", "")
    $text = $text.Replace("âš™ï¸ ", "")
    $text = $text.Replace("âš™ ", "")
    $text = $text.Replace("âœï¸ ", "")
    $text = $text.Replace("âž• ", "+ ")
    $text = $text.Replace("âš¡", "\u26a1")
    $text = $text.Replace("â¸ï¸ ", "")
    
    # Sort icons
    $text = $text.Replace("â–²", "\u25b2")
    $text = $text.Replace("â–¼", "\u25bc")
    $text = $text.Replace("â‡…", "\u21c5")
    
    # Calendar nav
    $text = $text.Replace("â—€ Prev", "\u2190 Prev")
    $text = $text.Replace("Next â–¶", "Next \u2192")
    
    # Calendar delete mini button
    $text = $text.Replace(">âœ•</button>", ">\u2715</button>")
    
    return $text
}
