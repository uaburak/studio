#!/bin/sh
# Writes StudioMac/StudioMac.xcodeproj from a fixed template. No third-party tools.
#
#   apps/apple/scripts/generate-project.sh
#
# - File-system-synchronized groups (Xcode 16+, objectVersion 77): every file
#   under StudioMac/StudioMac and StudioMac/StudioMacTests belongs to its target
#   automatically; the project never lists sources and does not change when
#   files are added.
# - StudioKit is a local Swift package (../StudioKit) linked into the app.
# - Build settings live in StudioMac/Config/*.xcconfig.
# - Object ids are fixed, so running this twice gives identical output.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$HERE/StudioMac/StudioMac.xcodeproj"
mkdir -p "$PROJ/xcshareddata/xcschemes"

PROJECT=5E0000000000000000000001
MAIN_GROUP=5E0000000000000000000002
PRODUCTS_GROUP=5E0000000000000000000003
CONFIG_GROUP=5E0000000000000000000004
PKG_REF=5E0000000000000000000005
PKG_PRODUCT=5E0000000000000000000006
PKG_BUILD_FILE=5E0000000000000000000007

APP_TARGET=5E0000000000000000000010
APP_PRODUCT=5E0000000000000000000011
APP_GROUP=5E0000000000000000000012
APP_SOURCES=5E0000000000000000000013
APP_FRAMEWORKS=5E0000000000000000000014
APP_RESOURCES=5E0000000000000000000015
APP_CONFIGS=5E0000000000000000000016
APP_DEBUG=5E0000000000000000000017
APP_RELEASE=5E0000000000000000000018

UNIT_TARGET=5E0000000000000000000020
UNIT_PRODUCT=5E0000000000000000000021
UNIT_GROUP=5E0000000000000000000022
UNIT_SOURCES=5E0000000000000000000023
UNIT_FRAMEWORKS=5E0000000000000000000024
UNIT_RESOURCES=5E0000000000000000000025
UNIT_CONFIGS=5E0000000000000000000026
UNIT_DEBUG=5E0000000000000000000027
UNIT_RELEASE=5E0000000000000000000028
UNIT_PROXY=5E0000000000000000000029
UNIT_DEP=5E000000000000000000002A

PROJ_CONFIGS=5E0000000000000000000040
PROJ_DEBUG=5E0000000000000000000041
PROJ_RELEASE=5E0000000000000000000042

XC_BASE=5E0000000000000000000050
XC_APP=5E0000000000000000000051
XC_UNIT=5E0000000000000000000052
INFO_PLIST=5E0000000000000000000054

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
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
		$UNIT_PROXY /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = $PROJECT /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = $APP_TARGET;
			remoteInfo = StudioMac;
		};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
		$APP_PRODUCT /* Studio.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Studio.app; sourceTree = BUILT_PRODUCTS_DIR; };
		$UNIT_PRODUCT /* StudioMacTests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = StudioMacTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
		$XC_BASE /* Base.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Base.xcconfig; sourceTree = "<group>"; };
		$XC_APP /* App.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = App.xcconfig; sourceTree = "<group>"; };
		$XC_UNIT /* Tests.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Tests.xcconfig; sourceTree = "<group>"; };
		$INFO_PLIST /* StudioMac-Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "StudioMac-Info.plist"; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		$APP_GROUP /* StudioMac */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioMac; sourceTree = "<group>"; };
		$UNIT_GROUP /* StudioMacTests */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioMacTests; sourceTree = "<group>"; };
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
		$APP_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ($PKG_BUILD_FILE /* StudioKit in Frameworks */,); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		$MAIN_GROUP = {
			isa = PBXGroup;
			children = (
				$APP_GROUP /* StudioMac */,
				$UNIT_GROUP /* StudioMacTests */,
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
				$INFO_PLIST /* StudioMac-Info.plist */,
			);
			path = Config;
			sourceTree = "<group>";
		};
		$PRODUCTS_GROUP /* Products */ = {
			isa = PBXGroup;
			children = (
				$APP_PRODUCT /* Studio.app */,
				$UNIT_PRODUCT /* StudioMacTests.xctest */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		$APP_TARGET /* StudioMac */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = $APP_CONFIGS;
			buildPhases = (
				$APP_SOURCES /* Sources */,
				$APP_FRAMEWORKS /* Frameworks */,
				$APP_RESOURCES /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				$APP_GROUP /* StudioMac */,
			);
			name = StudioMac;
			packageProductDependencies = (
				$PKG_PRODUCT /* StudioKit */,
			);
			productName = StudioMac;
			productReference = $APP_PRODUCT /* Studio.app */;
			productType = "com.apple.product-type.application";
		};
		$UNIT_TARGET /* StudioMacTests */ = {
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
				$UNIT_GROUP /* StudioMacTests */,
			);
			name = StudioMacTests;
			packageProductDependencies = (
			);
			productName = StudioMacTests;
			productReference = $UNIT_PRODUCT /* StudioMacTests.xctest */;
			productType = "com.apple.product-type.bundle.unit-test";
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
				$APP_TARGET /* StudioMac */,
				$UNIT_TARGET /* StudioMacTests */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		$APP_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		$APP_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
		$UNIT_DEP /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = $APP_TARGET /* StudioMac */;
			targetProxy = $UNIT_PROXY /* PBXContainerItemProxy */;
		};
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
		$PROJ_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_BASE /* Base.xcconfig */; buildSettings = {}; name = Debug; };
		$PROJ_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_BASE /* Base.xcconfig */; buildSettings = {}; name = Release; };
		$APP_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_APP /* App.xcconfig */; buildSettings = {}; name = Debug; };
		$APP_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_APP /* App.xcconfig */; buildSettings = {}; name = Release; };
		$UNIT_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UNIT /* Tests.xcconfig */; buildSettings = {}; name = Debug; };
		$UNIT_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UNIT /* Tests.xcconfig */; buildSettings = {}; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		$PROJ_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($PROJ_DEBUG, $PROJ_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$APP_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($APP_DEBUG, $APP_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$UNIT_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($UNIT_DEBUG, $UNIT_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
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
/* End XCSwiftPackageProductDependency section */
	};
	rootObject = $PROJECT /* Project object */;
}
EOF

ref() { # BlueprintIdentifier, BuildableName, BlueprintName
  printf '<BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "%s" BuildableName = "%s" BlueprintName = "%s" ReferencedContainer = "container:StudioMac.xcodeproj"></BuildableReference>' "$1" "$2" "$3"
}

cat > "$PROJ/xcshareddata/xcschemes/StudioMac.xcscheme" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "2700" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            $(ref $APP_TARGET Studio.app StudioMac)
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO" parallelizable = "NO">
            $(ref $UNIT_TARGET StudioMacTests.xctest StudioMacTests)
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         $(ref $APP_TARGET Studio.app StudioMac)
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         $(ref $APP_TARGET Studio.app StudioMac)
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"></ArchiveAction>
</Scheme>
EOF

echo "Wrote $PROJ"
