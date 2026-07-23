import AppKit

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: swift verify-desktop-icon.swift <png>\n", stderr)
  exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard
  let image = NSImage(contentsOf: url),
  let data = image.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: data)
else {
  fputs("Could not read icon PNG\n", stderr)
  exit(2)
}

var minX = bitmap.pixelsWide
var minY = bitmap.pixelsHigh
var maxX = 0
var maxY = 0
var lightPixelCount = 0

for y in 0..<bitmap.pixelsHigh {
  for x in 0..<bitmap.pixelsWide {
    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
    let isLightGlyph = color.alphaComponent > 0.5
      && color.redComponent > 0.5
      && color.greenComponent > 0.5
      && color.blueComponent > 0.5
    if isLightGlyph {
      minX = min(minX, x)
      minY = min(minY, y)
      maxX = max(maxX, x)
      maxY = max(maxY, y)
      lightPixelCount += 1
    }
  }
}

guard lightPixelCount > 10_000 else {
  fputs("Icon glyph was not detected\n", stderr)
  exit(1)
}

let centerX = Double(minX + maxX) / 2
let centerY = Double(minY + maxY) / 2
let expectedX = Double(bitmap.pixelsWide) / 2
let expectedY = Double(bitmap.pixelsHigh) / 2
let tolerance = 2.0

guard abs(centerX - expectedX) <= tolerance, abs(centerY - expectedY) <= tolerance else {
  fputs("Icon glyph is off-center: center=(\(centerX), \(centerY)), expected=(\(expectedX), \(expectedY))\n", stderr)
  exit(1)
}

print("Verified optical glyph center=(\(centerX), \(centerY))")
