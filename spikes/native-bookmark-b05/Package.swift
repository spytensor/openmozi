// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "NativeBookmarkB05",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "NativeBookmarkB05", targets: ["NativeBookmarkB05"])
    ],
    targets: [
        .executableTarget(
            name: "NativeBookmarkB05",
            path: "Sources/NativeBookmarkB05",
            linkerSettings: [
                .linkedFramework("AppKit")
            ]
        )
    ]
)
