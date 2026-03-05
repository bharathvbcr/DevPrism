cask "claude-prism" do
  version "0.5.0"

  sha256 ""
  url "https://github.com/delibae/claude-prism/releases/download/v#{version}/ClaudePrism_#{version}_aarch64.dmg"

  depends_on arch: :arm64

  name "ClaudePrism"
  desc "Desktop app for Claude-powered academic research workflows"
  homepage "https://github.com/delibae/claude-prism"

  depends_on macos: ">= :big_sur"

  app "ClaudePrism.app"

  zap trash: [
    "~/Library/Application Support/com.claude-prism.desktop",
    "~/Library/Caches/com.claude-prism.desktop",
    "~/Library/Preferences/com.claude-prism.desktop.plist",
    "~/Library/Saved Application State/com.claude-prism.desktop.savedState",
  ]
end
