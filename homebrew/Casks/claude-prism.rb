cask "claude-prism" do
  version "0.0.1"

  on_arm do
    sha256 "PLACEHOLDER_ARM64_SHA256"
    url "https://github.com/delibae/claude-prism/releases/download/v#{version}/ClaudePrism_#{version}_aarch64.dmg"
  end

  on_intel do
    sha256 "PLACEHOLDER_X64_SHA256"
    url "https://github.com/delibae/claude-prism/releases/download/v#{version}/ClaudePrism_#{version}_x64.dmg"
  end

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
