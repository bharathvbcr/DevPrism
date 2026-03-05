cask "claude-prism" do
  version "0.4.0"

  sha256 "c697b3c8faf0646810dc6e1e2c28252333233a04284b68c6d5b3352b75da0b8b"
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
