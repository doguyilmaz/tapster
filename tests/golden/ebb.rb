cask "ebb" do
  version "0.1.1"

  on_macos do
    sha256 "4444444444444444444444444444444444444444444444444444444444444444"

    url "https://github.com/o/ebb/releases/download/v#{version}/ebb_#{version}_darwin_universal.tar.gz"
  end

  name "ebb"
  desc "Shows where disk space went \#{and} \"wins\""
  homepage "https://github.com/o/ebb"

  livecheck do
    skip "tapster"
  end

  depends_on :macos

  app "ebb.app"
  binary "#{appdir}/ebb.app/Contents/MacOS/ebb"

  postflight_steps do
    run "bin/ebb",
        base:         :homebrew_prefix,
        args:         ["daemon", "restore"],
        must_succeed: false
  end

  uninstall launchctl: "com.doguyilmaz.ebb"

  zap trash: ["~/.config/ebb", "~/.local/state/ebb"]
end
