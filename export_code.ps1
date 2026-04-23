# Export kodu quantum-be backendu
$outputFile = "quantum_be_export.txt"
$srcPath = "src"

$header = @"
QUANTUM-BE BACKEND - KOMPLETNI EXPORT KODU
Vygenerovano: $(Get-Date -Format "dd.MM.yyyy HH:mm:ss")
================================================================================

STRUKTURA PROJEKTU (tree src /f):

$(tree src /f 2>&1 | Out-String)

================================================================================

"@

$header | Out-File -FilePath $outputFile -Encoding UTF8

$files = Get-ChildItem -Path $srcPath -Recurse -Filter "*.ts" | Sort-Object FullName

foreach ($file in $files) {
    $separator = "=" * 80
    $fileHeader = @"

$separator
SOUBOR: $($file.FullName.Replace((Get-Location).Path + "\", ""))
$separator

"@
    $fileHeader | Add-Content -Path $outputFile -Encoding UTF8
    Get-Content $file.FullName | Add-Content -Path $outputFile -Encoding UTF8
}

$count = $files.Count
"`nCELKEM SOUBORU: $count" | Add-Content -Path $outputFile -Encoding UTF8

Write-Host "✅ Export hotov: $outputFile ($count souboru)" -ForegroundColor Green