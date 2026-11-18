#!/bin/sh
# Writes StudioIOS/StudioIOS.xcodeproj from a fixed template. No third-party tools.
#
#   apps/apple/scripts/generate-ios-project.sh
#
# - File-system-synchronized groups (Xcode 16+, objectVersion 77): every file
#   under StudioIOS/StudioIOS, StudioIOS/StudioIOSTests, StudioIOS/StudioShare and
#   StudioIOS/StudioWidget belongs to its target automatically.
# - Targets: the app (Studio.app), its unit tests, the share extension
#   ("Studio'ya gönder", StudioShare.appex, N20) and the widget (StudioWidget.appex,
#   N22); both extensions are embedded in the app.
# - StudioKit is a local Swift package (../StudioKit) linked into the app and both extensions.
# - Build settings live in StudioIOS/Config/*.xcconfig; entitlements (App Group and
#   the shared Keychain group, see STUDIO_SHARING in Base.xcconfig) in
#   StudioIOS/Config/Entitlements.
# - Object ids are fixed, so running this twice gives identical output.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$HERE/StudioIOS/StudioIOS.xcodeproj"
mkdir -p "$PROJ/xcshareddata/xcschemes"

PROJECT=6F0000000000000000000001
MAIN_GROUP=6F0000000000000000000002
PRODUCTS_GROUP=6F0000000000000000000003
CONFIG_GROUP=6F0000000000000000000004
PKG_REF=6F0000000000000000000005
PKG_PRODUCT=6F0000000000000000000006
PKG_BUILD_FILE=6F0000000000000000000007

APP_TARGET=6F0000000000000000000010
APP_PRODUCT=6F0000000000000000000011
APP_GROUP=6F0000000000000000000012
APP_SOURCES=6F0000000000000000000013
APP_FRAMEWORKS=6F0000000000000000000014
APP_RESOURCES=6F0000000000000000000015
APP_CONFIGS=6F0000000000000000000016
APP_DEBUG=6F0000000000000000000017
APP_RELEASE=6F0000000000000000000018
APP_EMBED=6F0000000000000000000019

UNIT_TARGET=6F0000000000000000000020
UNIT_PRODUCT=6F0000000000000000000021
UNIT_GROUP=6F0000000000000000000022
UNIT_SOURCES=6F0000000000000000000023
UNIT_FRAMEWORKS=6F0000000000000000000024
UNIT_RESOURCES=6F0000000000000000000025
UNIT_CONFIGS=6F0000000000000000000026
UNIT_DEBUG=6F0000000000000000000027
UNIT_RELEASE=6F0000000000000000000028
UNIT_PROXY=6F0000000000000000000029
UNIT_DEP=6F000000000000000000002A

SHARE_TARGET=6F0000000000000000000030
SHARE_PRODUCT=6F0000000000000000000031
SHARE_GROUP=6F0000000000000000000032
SHARE_SOURCES=6F0000000000000000000033
SHARE_FRAMEWORKS=6F0000000000000000000034
SHARE_RESOURCES=6F0000000000000000000035
SHARE_CONFIGS=6F0000000000000000000036
SHARE_DEBUG=6F0000000000000000000037
SHARE_RELEASE=6F0000000000000000000038
SHARE_PROXY=6F0000000000000000000039
SHARE_DEP=6F000000000000000000003A
SHARE_PKG_PRODUCT=6F000000000000000000003B
SHARE_PKG_BUILD_FILE=6F000000000000000000003C
SHARE_EMBED_FILE=6F000000000000000000003D

PROJ_CONFIGS=6F0000000000000000000040
PROJ_DEBUG=6F0000000000000000000041
PROJ_RELEASE=6F0000000000000000000042

XC_BASE=6F0000000000000000000050
XC_APP=6F0000000000000000000051
XC_UNIT=6F0000000000000000000052
INFO_PLIST=6F0000000000000000000054
XC_SHARE=6F0000000000000000000055
XC_WIDGET=6F0000000000000000000056
SHARE_PLIST=6F0000000000000000000057
WIDGET_PLIST=6F0000000000000000000058
ENT_GROUP=6F0000000000000000000059
ENT_APP=6F000000000000000000005A
ENT_APP_KEYCHAIN=6F000000000000000000005B
ENT_SHARE=6F000000000000000000005C
ENT_SHARE_KEYCHAIN=6F000000000000000000005D
ENT_WIDGET=6F000000000000000000005E
ENT_WIDGET_KEYCHAIN=6F000000000000000000005F

WIDGET_TARGET=6F0000000000000000000060
WIDGET_PRODUCT=6F0000000000000000000061
WIDGET_GROUP=6F0000000000000000000062
WIDGET_SOURCES=6F0000000000000000000063
WIDGET_FRAMEWORKS=6F0000000000000000000064
WIDGET_RESOURCES=6F0000000000000000000065
WIDGET_CONFIGS=6F0000000000000000000066
WIDGET_DEBUG=6F0000000000000000000067
WIDGET_RELEASE=6F0000000000000000000068
WIDGET_PROXY=6F0000000000000000000069
WIDGET_DEP=6F000000000000000000006A
WIDGET_PKG_PRODUCT=6F000000000000000000006B
WIDGET_PKG_BUILD_FILE=6F000000000000000000006C
WIDGET_EMBED_FILE=6F000000000000000000006D

cat > "$PROJ/project.pbxproj" <<EOF
// !\$*UTF8*\$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 77;
	objects = {

/* Begin PBXBuildFile section */
		$PKG_BUILD_FILE /* StudioKit in Frameworks */ = {isa = PBXBuildFile; productRef = $PKG_PRODUCT /* StudioKit */; };
		$SHARE_PKG_BUILD_FILE /* StudioKit in Frameworks */ = {isa = PBXBuildFile; productRef = $SHARE_PKG_PRODUCT /* StudioKit */; };
		$WIDGET_PKG_BUILD_FILE /* StudioKit in Frameworks */ = {isa = PBXBuildFile; productRef = $WIDGET_PKG_PRODUCT /* StudioKit */; };
		$SHARE_EMBED_FILE /* StudioShare.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = $SHARE_PRODUCT /* StudioShare.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
		$WIDGET_EMBED_FILE /* StudioWidget.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = $WIDGET_PRODUCT /* StudioWidget.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
		$UNIT_PROXY /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = $PROJECT /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = $APP_TARGET;
			remoteInfo = StudioIOS;
		};
		$SHARE_PROXY /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = $PROJECT /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = $SHARE_TARGET;
			remoteInfo = StudioShare;
		};
		$WIDGET_PROXY /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = $PROJECT /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = $WIDGET_TARGET;
			remoteInfo = StudioWidget;
		};
/* End PBXContainerItemProxy section */

/* Begin PBXCopyFilesBuildPhase section */
		$APP_EMBED /* Embed Foundation Extensions */ = {
			isa = PBXCopyFilesBuildPhase;
			buildActionMask = 2147483647;
			dstPath = "";
			dstSubfolderSpec = 13;
			files = (
				$SHARE_EMBED_FILE /* StudioShare.appex in Embed Foundation Extensions */,
				$WIDGET_EMBED_FILE /* StudioWidget.appex in Embed Foundation Extensions */,
			);
			name = "Embed Foundation Extensions";
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXCopyFilesBuildPhase section */

/* Begin PBXFileReference section */
		$APP_PRODUCT /* Studio.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Studio.app; sourceTree = BUILT_PRODUCTS_DIR; };
		$UNIT_PRODUCT /* StudioIOSTests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = StudioIOSTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
		$SHARE_PRODUCT /* StudioShare.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = StudioShare.appex; sourceTree = BUILT_PRODUCTS_DIR; };
		$WIDGET_PRODUCT /* StudioWidget.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = StudioWidget.appex; sourceTree = BUILT_PRODUCTS_DIR; };
		$XC_BASE /* Base.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Base.xcconfig; sourceTree = "<group>"; };
		$XC_APP /* App.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = App.xcconfig; sourceTree = "<group>"; };
		$XC_UNIT /* Tests.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Tests.xcconfig; sourceTree = "<group>"; };
		$XC_SHARE /* Share.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Share.xcconfig; sourceTree = "<group>"; };
		$XC_WIDGET /* Widget.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Widget.xcconfig; sourceTree = "<group>"; };
		$INFO_PLIST /* StudioIOS-Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "StudioIOS-Info.plist"; sourceTree = "<group>"; };
		$SHARE_PLIST /* StudioShare-Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "StudioShare-Info.plist"; sourceTree = "<group>"; };
		$WIDGET_PLIST /* StudioWidget-Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "StudioWidget-Info.plist"; sourceTree = "<group>"; };
		$ENT_APP /* StudioIOS.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = StudioIOS.entitlements; sourceTree = "<group>"; };
		$ENT_APP_KEYCHAIN /* StudioIOS-Keychain.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = "StudioIOS-Keychain.entitlements"; sourceTree = "<group>"; };
		$ENT_SHARE /* StudioShare.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = StudioShare.entitlements; sourceTree = "<group>"; };
		$ENT_SHARE_KEYCHAIN /* StudioShare-Keychain.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = "StudioShare-Keychain.entitlements"; sourceTree = "<group>"; };
		$ENT_WIDGET /* StudioWidget.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = StudioWidget.entitlements; sourceTree = "<group>"; };
		$ENT_WIDGET_KEYCHAIN /* StudioWidget-Keychain.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = "StudioWidget-Keychain.entitlements"; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		$APP_GROUP /* StudioIOS */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioIOS; sourceTree = "<group>"; };
		$UNIT_GROUP /* StudioIOSTests */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioIOSTests; sourceTree = "<group>"; };
		$SHARE_GROUP /* StudioShare */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioShare; sourceTree = "<group>"; };
		$WIDGET_GROUP /* StudioWidget */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioWidget; sourceTree = "<group>"; };
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
		$APP_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ($PKG_BUILD_FILE /* StudioKit in Frameworks */,); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$SHARE_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ($SHARE_PKG_BUILD_FILE /* StudioKit in Frameworks */,); runOnlyForDeploymentPostprocessing = 0; };
		$WIDGET_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ($WIDGET_PKG_BUILD_FILE /* StudioKit in Frameworks */,); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		$MAIN_GROUP = {
			isa = PBXGroup;
			children = (
				$APP_GROUP /* StudioIOS */,
				$UNIT_GROUP /* StudioIOSTests */,
				$SHARE_GROUP /* StudioShare */,
				$WIDGET_GROUP /* StudioWidget */,
				$CONFIG_GROUP /* Config */,
				$PRODUCTS_GROUP /* Products */,
			);
			sourceTree = "<group>";
		};
		$CONFIG_GROUP /* Config */ = {
			isa = PBXGroup;
			children = (
				$XC_BASE /* Base.xcconfig */,
				$XC_APP /* App.xcconfig */,
				$XC_UNIT /* Tests.xcconfig */,
				$XC_SHARE /* Share.xcconfig */,
				$XC_WIDGET /* Widget.xcconfig */,
				$INFO_PLIST /* StudioIOS-Info.plist */,
				$SHARE_PLIST /* StudioShare-Info.plist */,
				$WIDGET_PLIST /* StudioWidget-Info.plist */,
				$ENT_GROUP /* Entitlements */,
			);
			path = Config;
			sourceTree = "<group>";
		};
		$ENT_GROUP /* Entitlements */ = {
			isa = PBXGroup;
			children = (
				$ENT_APP /* StudioIOS.entitlements */,
				$ENT_APP_KEYCHAIN /* StudioIOS-Keychain.entitlements */,
				$ENT_SHARE /* StudioShare.entitlements */,
				$ENT_SHARE_KEYCHAIN /* StudioShare-Keychain.entitlements */,
				$ENT_WIDGET /* StudioWidget.entitlements */,
				$ENT_WIDGET_KEYCHAIN /* StudioWidget-Keychain.entitlements */,
			);
			path = Entitlements;
			sourceTree = "<group>";
		};
		$PRODUCTS_GROUP /* Products */ = {
			isa = PBXGroup;
			children = (
				$APP_PRODUCT /* Studio.app */,
				$UNIT_PRODUCT /* StudioIOSTests.xctest */,
				$SHARE_PRODUCT /* StudioShare.appex */,
				$WIDGET_PRODUCT /* StudioWidget.appex */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		$APP_TARGET /* StudioIOS */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = $APP_CONFIGS;
			buildPhases = (
				$APP_SOURCES /* Sources */,
				$APP_FRAMEWORKS /* Frameworks */,
				$APP_RESOURCES /* Resources */,
				$APP_EMBED /* Embed Foundation Extensions */,
			);
			buildRules = (
			);
			dependencies = (
				$SHARE_DEP /* PBXTargetDependency */,
				$WIDGET_DEP /* PBXTargetDependency */,
			);
			fileSystemSynchronizedGroups = (
				$APP_GROUP /* StudioIOS */,
			);
			name = StudioIOS;
			packageProductDependencies = (
				$PKG_PRODUCT /* StudioKit */,
			);
			productName = StudioIOS;
			productReference = $APP_PRODUCT /* Studio.app */;
			productType = "com.apple.product-type.application";
		};
		$UNIT_TARGET /* StudioIOSTests */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = $UNIT_CONFIGS;
			buildPhases = (
				$UNIT_SOURCES /* Sources */,
				$UNIT_FRAMEWORKS /* Frameworks */,
				$UNIT_RESOURCES /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
				$UNIT_DEP /* PBXTargetDependency */,
			);
			fileSystemSynchronizedGroups = (
				$UNIT_GROUP /* StudioIOSTests */,
			);
			name = StudioIOSTests;
			packageProductDependencies = (
			);
			productName = StudioIOSTests;
			productReference = $UNIT_PRODUCT /* StudioIOSTests.xctest */;
			productType = "com.apple.product-type.bundle.unit-test";
		};
		$SHARE_TARGET /* StudioShare */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = $SHARE_CONFIGS;
			buildPhases = (
				$SHARE_SOURCES /* Sources */,
				$SHARE_FRAMEWORKS /* Frameworks */,
				$SHARE_RESOURCES /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				$SHARE_GROUP /* StudioShare */,
			);
			name = StudioShare;
			packageProductDependencies = (
				$SHARE_PKG_PRODUCT /* StudioKit */,
			);
			productName = StudioShare;
			productReference = $SHARE_PRODUCT /* StudioShare.appex */;
			productType = "com.apple.product-type.app-extension";
		};
		$WIDGET_TARGET /* StudioWidget */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = $WIDGET_CONFIGS;
			buildPhases = (
				$WIDGET_SOURCES /* Sources */,
				$WIDGET_FRAMEWORKS /* Frameworks */,
				$WIDGET_RESOURCES /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				$WIDGET_GROUP /* StudioWidget */,
			);
			name = StudioWidget;
			packageProductDependencies = (
				$WIDGET_PKG_PRODUCT /* StudioKit */,
			);
			productName = StudioWidget;
			productReference = $WIDGET_PRODUCT /* StudioWidget.appex */;
			productType = "com.apple.product-type.app-extension";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		$PROJECT /* Project object */ = {
			isa = PBXProject;
			attributes = {
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 2700;
				LastUpgradeCheck = 2700;
				TargetAttributes = {
					$APP_TARGET = {
						CreatedOnToolsVersion = 27.0;
					};
					$UNIT_TARGET = {
						CreatedOnToolsVersion = 27.0;
						TestTargetID = $APP_TARGET;
					};
					$SHARE_TARGET = {
						CreatedOnToolsVersion = 27.0;
					};
					$WIDGET_TARGET = {
						CreatedOnToolsVersion = 27.0;
					};
				};
			};
			buildConfigurationList = $PROJ_CONFIGS;
			developmentRegion = tr;
			hasScannedForEncodings = 0;
			knownRegions = (
				tr,
				Base,
			);
			mainGroup = $MAIN_GROUP;
			minimizedProjectReferenceProxies = 1;
			packageReferences = (
				$PKG_REF /* XCLocalSwiftPackageReference "../StudioKit" */,
			);
			preferredProjectObjectVersion = 77;
			productRefGroup = $PRODUCTS_GROUP /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				$APP_TARGET /* StudioIOS */,
				$UNIT_TARGET /* StudioIOSTests */,
				$SHARE_TARGET /* StudioShare */,
				$WIDGET_TARGET /* StudioWidget */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		$APP_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$SHARE_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$WIDGET_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		$APP_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$SHARE_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$WIDGET_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
		$UNIT_DEP /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = $APP_TARGET /* StudioIOS */;
			targetProxy = $UNIT_PROXY /* PBXContainerItemProxy */;
		};
		$SHARE_DEP /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = $SHARE_TARGET /* StudioShare */;
			targetProxy = $SHARE_PROXY /* PBXContainerItemProxy */;
		};
		$WIDGET_DEP /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = $WIDGET_TARGET /* StudioWidget */;
			targetProxy = $WIDGET_PROXY /* PBXContainerItemProxy */;
		};
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
		$PROJ_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_BASE /* Base.xcconfig */; buildSettings = {}; name = Debug; };
		$PROJ_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_BASE /* Base.xcconfig */; buildSettings = {}; name = Release; };
		$APP_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_APP /* App.xcconfig */; buildSettings = {}; name = Debug; };
		$APP_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_APP /* App.xcconfig */; buildSettings = {}; name = Release; };
		$UNIT_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UNIT /* Tests.xcconfig */; buildSettings = {}; name = Debug; };
		$UNIT_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UNIT /* Tests.xcconfig */; buildSettings = {}; name = Release; };
		$SHARE_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_SHARE /* Share.xcconfig */; buildSettings = {}; name = Debug; };
		$SHARE_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_SHARE /* Share.xcconfig */; buildSettings = {}; name = Release; };
		$WIDGET_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_WIDGET /* Widget.xcconfig */; buildSettings = {}; name = Debug; };
		$WIDGET_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_WIDGET /* Widget.xcconfig */; buildSettings = {}; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		$PROJ_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($PROJ_DEBUG, $PROJ_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$APP_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($APP_DEBUG, $APP_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$UNIT_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($UNIT_DEBUG, $UNIT_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$SHARE_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($SHARE_DEBUG, $SHARE_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$WIDGET_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($WIDGET_DEBUG, $WIDGET_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */

/* Begin XCLocalSwiftPackageReference section */
		$PKG_REF /* XCLocalSwiftPackageReference "../StudioKit" */ = {
			isa = XCLocalSwiftPackageReference;
			relativePath = ../StudioKit;
		};
/* End XCLocalSwiftPackageReference section */

/* Begin XCSwiftPackageProductDependency section */
		$PKG_PRODUCT /* StudioKit */ = {
			isa = XCSwiftPackageProductDependency;
			productName = StudioKit;
		};
		$SHARE_PKG_PRODUCT /* StudioKit */ = {
			isa = XCSwiftPackageProductDependency;
			productName = StudioKit;
		};
		$WIDGET_PKG_PRODUCT /* StudioKit */ = {
			isa = XCSwiftPackageProductDependency;
			productName = StudioKit;
		};
/* End XCSwiftPackageProductDependency section */
	};
	rootObject = $PROJECT /* Project object */;
}
EOF

ref() { # BlueprintIdentifier, BuildableName, BlueprintName
  printf '<BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "%s" BuildableName = "%s" BlueprintName = "%s" ReferencedContainer = "container:StudioIOS.xcodeproj"></BuildableReference>' "$1" "$2" "$3"
}

cat > "$PROJ/xcshareddata/xcschemes/StudioIOS.xcscheme" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "2700" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            $(ref $APP_TARGET Studio.app StudioIOS)
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO" parallelizable = "NO">
            $(ref $UNIT_TARGET StudioIOSTests.xctest StudioIOSTests)
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         $(ref $APP_TARGET Studio.app StudioIOS)
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         $(ref $APP_TARGET Studio.app StudioIOS)
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"></ArchiveAction>
</Scheme>
EOF

echo "Wrote $PROJ"
