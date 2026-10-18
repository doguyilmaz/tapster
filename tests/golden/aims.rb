cask "aims" do
  version "0.1.5"

  on_macos do
    on_arm do
      sha256 "1111111111111111111111111111111111111111111111111111111111111111"
      url "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_darwin_arm64.tar.gz"
    end
    on_intel do
      sha256 "2222222222222222222222222222222222222222222222222222222222222222"
      url "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_darwin_amd64.tar.gz"
    end
  end
  on_linux do
    on_intel do
      sha256 "3333333333333333333333333333333333333333333333333333333333333333"
      url "https://github.com/o/aims/releases/download/v0.1.5/aims_0.1.5_linux_amd64.tar.gz"
    end
  end

  name "aims"
  desc "Several Claude Code and Codex accounts on one machine"
  homepage "https://doguyilmaz.github.io/aims/"

  livecheck do
    skip "tapster"
  end

  binary "aims"
  bash_completion "completions/aims.bash"
  zsh_completion "completions/aims.zsh"
end
