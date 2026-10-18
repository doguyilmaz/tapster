cask "ebb" do
  version "0.1.1"

  on_macos do
    sha256 "4444444444444444444444444444444444444444444444444444444444444444"

    url "https://github.com/o/ebb/releases/download/v0.1.1/ebb_0.1.1_darwin_universal.tar.gz"
  end

  name "ebb"
  desc "Shows where disk space went \#{and} \"wins\""
  homepage "https://github.com/o/ebb"

  livecheck do
    skip "tapster"
  end

  binary "ebb"

  uninstall launchctl: "com.doguyilmaz.ebb"

  zap trash: ["~/.config/ebb", "~/.local/state/ebb"]
end
