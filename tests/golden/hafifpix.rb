cask "hafifpix" do
  version "1.3.1"
  sha256 "5555555555555555555555555555555555555555555555555555555555555555"

  url "https://github.com/doguyilmaz/hafifpix/releases/download/v#{version}/HafifPix-#{version}.dmg"
  name "HafifPix"
  desc "Image compressor that keeps quality"
  homepage "https://github.com/doguyilmaz/hafifpix"

  livecheck do
    skip "tapster"
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "HafifPix.app"
  binary "#{appdir}/HafifPix.app/Contents/Resources/bin/hafif"

  uninstall quit: "com.doguyilmaz.HafifPix"

  zap trash: "~/Library/Preferences/com.doguyilmaz.HafifPix.plist"
end
