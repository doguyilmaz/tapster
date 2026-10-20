cask "ebb-linux" do
  version "0.1.1"

  on_macos do
    sha256 "4444444444444444444444444444444444444444444444444444444444444444"

    url "https://github.com/o/ebb/releases/download/v#{version}/ebb_#{version}_darwin_universal.tar.gz"

    app "ebb.app"
    binary "#{appdir}/ebb.app/Contents/MacOS/ebb"

    uninstall launchctl: "com.doguyilmaz.ebb",
              quit:      "com.doguyilmaz.ebb"
  end
  on_linux do
    on_intel do
      sha256 "5555555555555555555555555555555555555555555555555555555555555555"
      url "https://github.com/o/ebb/releases/download/v#{version}/ebb_#{version}_linux_amd64.tar.gz"
    end

    binary "ebb"
  end

  name "ebb-linux"
  desc "Shows where disk space went"
  homepage "https://github.com/o/ebb"

  livecheck do
    skip "tapster"
  end

  postflight_steps do
    run "bin/ebb",
        base:         :homebrew_prefix,
        args:         ["daemon", "restore"],
        must_succeed: false
  end

  zap trash: ["~/.config/ebb", "~/.local/state/ebb"]
end
