// The pictures of the TV app from the kibbl. logo: the banner in Google TV's row of apps
// (res/drawable-xhdpi/banner.png, 320 x 180, the logo and "kibbl. light" on the night colours of
// the app) and the icon (res/mipmap-xhdpi/ic_launcher.png, 192 x 192).
//   swift tv/tools/banner.swift <logo.svg> <banner.png> <icon.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let icon = NSImage(contentsOfFile: args[1]) else {
    fputs("usage: banner.swift <logo.svg> <banner.png> <icon.png>\n", stderr)
    exit(1)
}

func png(_ w: Int, _ h: Int, to path: String, draw: () -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

png(320, 180, to: args[2]) {
    color(0x1c120d).setFill()
    NSRect(x: 0, y: 0, width: 320, height: 180).fill()
    icon.draw(in: NSRect(x: 24, y: 50, width: 80, height: 80))
    let font = NSFont.systemFont(ofSize: 40, weight: .heavy)
    let text = NSMutableAttributedString(string: "kibbl.", attributes: [.font: font, .foregroundColor: color(0xf3e6cf)])
    text.append(NSAttributedString(string: "\nlight", attributes: [.font: font, .foregroundColor: color(0xd9622b)]))
    text.draw(in: NSRect(x: 120, y: 38, width: 190, height: 110))
}
png(192, 192, to: args[3]) {
    icon.draw(in: NSRect(x: 0, y: 0, width: 192, height: 192))
}
