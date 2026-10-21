cask "aims-app" do
  version "0.1.5"

  on_macos do
    on_arm do
      sha256 "1111111111111111111111111111111111111111111111111111111111111111"
      url "https://github.com/o/aims-app/releases/download/v#{version}/aims_#{version}_darwin_arm64.tar.gz"
    end
    on_intel do
      sha256 "2222222222222222222222222222222222222222222222222222222222222222"
      url "https://github.com/o/aims-app/releases/download/v#{version}/aims_#{version}_darwin_amd64.tar.gz"
    end

    app "aims.app"
    binary "#{appdir}/aims.app/Contents/MacOS/aims"

    uninstall launchctl: "com.o.aims.keepalive"
  end
  on_linux do
    on_arm do
      sha256 "3333333333333333333333333333333333333333333333333333333333333333"
      url "https://github.com/o/aims-app/releases/download/v#{version}/aims_#{version}_linux_arm64.tar.gz"
    end
    on_intel do
      sha256 "4444444444444444444444444444444444444444444444444444444444444444"
      url "https://github.com/o/aims-app/releases/download/v#{version}/aims_#{version}_linux_amd64.tar.gz"
    end

    binary "aims"
  end

  name "aims-app"
  desc "Several Claude Code and Codex accounts on one machine"
  homepage "https://doguyilmaz.github.io/aims/"

  livecheck do
    skip "tapster"
  end

  bash_completion "completions/aims.bash"
  zsh_completion "completions/aims.zsh"

  zap trash: "~/.config/aims"
end
