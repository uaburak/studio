#!/bin/sh
# Writes Studio.xcodeproj from a fixed template. No third-party tools.
#
#   apps/ios/scripts/generate-project.sh
#
# The project uses file-system-synchronized groups (Xcode 16+, objectVersion 77):
# every file under Studio/, StudioTests/ and StudioUITests/ belongs to its
# target automatically, so the project file never lists sources and does not
# change when files are added. Build settings live in Config/*.xcconfig.
# Object ids are fixed, so running this script twice gives identical output.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$HERE/Studio.xcodeproj"
mkdir -p "$PROJ/xcshareddata/xcschemes"

# Fixed object ids (24 hex digits).
PROJECT=5D0000000000000000000001
MAIN_GROUP=5D0000000000000000000002
PRODUCTS_GROUP=5D0000000000000000000003
CONFIG_GROUP=5D0000000000000000000004

APP_TARGET=5D0000000000000000000010
APP_PRODUCT=5D0000000000000000000011
APP_GROUP=5D0000000000000000000012
APP_SOURCES=5D0000000000000000000013
APP_FRAMEWORKS=5D0000000000000000000014
APP_RESOURCES=5D0000000000000000000015
APP_CONFIGS=5D0000000000000000000016
APP_DEBUG=5D0000000000000000000017
APP_RELEASE=5D0000000000000000000018

UNIT_TARGET=5D0000000000000000000020
UNIT_PRODUCT=5D0000000000000000000021
UNIT_GROUP=5D0000000000000000000022
UNIT_SOURCES=5D0000000000000000000023
UNIT_FRAMEWORKS=5D0000000000000000000024
UNIT_RESOURCES=5D0000000000000000000025
UNIT_CONFIGS=5D0000000000000000000026
UNIT_DEBUG=5D0000000000000000000027
UNIT_RELEASE=5D0000000000000000000028
UNIT_PROXY=5D0000000000000000000029
UNIT_DEP=5D000000000000000000002A

UI_TARGET=5D0000000000000000000030
UI_PRODUCT=5D0000000000000000000031
UI_GROUP=5D0000000000000000000032
UI_SOURCES=5D0000000000000000000033
UI_FRAMEWORKS=5D0000000000000000000034
UI_RESOURCES=5D0000000000000000000035
UI_CONFIGS=5D0000000000000000000036
UI_DEBUG=5D0000000000000000000037
UI_RELEASE=5D0000000000000000000038
UI_PROXY=5D0000000000000000000039
UI_DEP=5D000000000000000000003A

PROJ_CONFIGS=5D0000000000000000000040
PROJ_DEBUG=5D0000000000000000000041
PROJ_RELEASE=5D0000000000000000000042

XC_BASE=5D0000000000000000000050
XC_APP=5D0000000000000000000051
XC_UNIT=5D0000000000000000000052
XC_UI=5D0000000000000000000053
INFO_PLIST=5D0000000000000000000054

cat > "$PROJ/project.pbxproj" <<EOF
// !\$*UTF8*\$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 77;
	objects = {

/* Begin PBXContainerItemProxy section */
		$UNIT_PROXY /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = $PROJECT /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = $APP_TARGET;
			remoteInfo = Studio;
		};
		$UI_PROXY /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = $PROJECT /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = $APP_TARGET;
			remoteInfo = Studio;
		};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
		$APP_PRODUCT /* Studio.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Studio.app; sourceTree = BUILT_PRODUCTS_DIR; };
		$UNIT_PRODUCT /* StudioTests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = StudioTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
		$UI_PRODUCT /* StudioUITests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = StudioUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
		$XC_BASE /* Base.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Base.xcconfig; sourceTree = "<group>"; };
		$XC_APP /* App.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = App.xcconfig; sourceTree = "<group>"; };
		$XC_UNIT /* Tests.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Tests.xcconfig; sourceTree = "<group>"; };
		$XC_UI /* UITests.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = UITests.xcconfig; sourceTree = "<group>"; };
		$INFO_PLIST /* Studio-Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "Studio-Info.plist"; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		$APP_GROUP /* Studio */ = {isa = PBXFileSystemSynchronizedRootGroup; path = Studio; sourceTree = "<group>"; };
		$UNIT_GROUP /* StudioTests */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioTests; sourceTree = "<group>"; };
		$UI_GROUP /* StudioUITests */ = {isa = PBXFileSystemSynchronizedRootGroup; path = StudioUITests; sourceTree = "<group>"; };
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
		$APP_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UI_FRAMEWORKS /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		$MAIN_GROUP = {
			isa = PBXGroup;
			children = (
				$APP_GROUP /* Studio */,
				$UNIT_GROUP /* StudioTests */,
				$UI_GROUP /* StudioUITests */,
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
				$XC_UI /* UITests.xcconfig */,
				$INFO_PLIST /* Studio-Info.plist */,
			);
			path = Config;
			sourceTree = "<group>";
		};
		$PRODUCTS_GROUP /* Products */ = {
			isa = PBXGroup;
			children = (
				$APP_PRODUCT /* Studio.app */,
				$UNIT_PRODUCT /* StudioTests.xctest */,
				$UI_PRODUCT /* StudioUITests.xctest */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		$APP_TARGET /* Studio */ = {
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
				$APP_GROUP /* Studio */,
			);
			name = Studio;
			packageProductDependencies = (
			);
			productName = Studio;
			productReference = $APP_PRODUCT /* Studio.app */;
			productType = "com.apple.product-type.application";
		};
		$UNIT_TARGET /* StudioTests */ = {
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
				$UNIT_GROUP /* StudioTests */,
			);
			name = StudioTests;
			packageProductDependencies = (
			);
			productName = StudioTests;
			productReference = $UNIT_PRODUCT /* StudioTests.xctest */;
			productType = "com.apple.product-type.bundle.unit-test";
		};
		$UI_TARGET /* StudioUITests */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = $UI_CONFIGS;
			buildPhases = (
				$UI_SOURCES /* Sources */,
				$UI_FRAMEWORKS /* Frameworks */,
				$UI_RESOURCES /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
				$UI_DEP /* PBXTargetDependency */,
			);
			fileSystemSynchronizedGroups = (
				$UI_GROUP /* StudioUITests */,
			);
			name = StudioUITests;
			packageProductDependencies = (
			);
			productName = StudioUITests;
			productReference = $UI_PRODUCT /* StudioUITests.xctest */;
			productType = "com.apple.product-type.bundle.ui-testing";
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
					$UI_TARGET = {
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
			preferredProjectObjectVersion = 77;
			productRefGroup = $PRODUCTS_GROUP /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				$APP_TARGET /* Studio */,
				$UNIT_TARGET /* StudioTests */,
				$UI_TARGET /* StudioUITests */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		$APP_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UI_RESOURCES /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		$APP_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UNIT_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		$UI_SOURCES /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
		$UNIT_DEP /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = $APP_TARGET /* Studio */;
			targetProxy = $UNIT_PROXY /* PBXContainerItemProxy */;
		};
		$UI_DEP /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = $APP_TARGET /* Studio */;
			targetProxy = $UI_PROXY /* PBXContainerItemProxy */;
		};
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
		$PROJ_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_BASE /* Base.xcconfig */; buildSettings = {}; name = Debug; };
		$PROJ_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_BASE /* Base.xcconfig */; buildSettings = {}; name = Release; };
		$APP_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_APP /* App.xcconfig */; buildSettings = {}; name = Debug; };
		$APP_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_APP /* App.xcconfig */; buildSettings = {}; name = Release; };
		$UNIT_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UNIT /* Tests.xcconfig */; buildSettings = {}; name = Debug; };
		$UNIT_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UNIT /* Tests.xcconfig */; buildSettings = {}; name = Release; };
		$UI_DEBUG /* Debug */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UI /* UITests.xcconfig */; buildSettings = {}; name = Debug; };
		$UI_RELEASE /* Release */ = {isa = XCBuildConfiguration; baseConfigurationReference = $XC_UI /* UITests.xcconfig */; buildSettings = {}; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		$PROJ_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($PROJ_DEBUG, $PROJ_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$APP_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($APP_DEBUG, $APP_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$UNIT_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($UNIT_DEBUG, $UNIT_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		$UI_CONFIGS = {isa = XCConfigurationList; buildConfigurations = ($UI_DEBUG, $UI_RELEASE); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
	};
	rootObject = $PROJECT /* Project object */;
}
EOF

ref() { # BlueprintIdentifier, BuildableName, BlueprintName
  printf '<BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "%s" BuildableName = "%s" BlueprintName = "%s" ReferencedContainer = "container:Studio.xcodeproj"></BuildableReference>' "$1" "$2" "$3"
}

cat > "$PROJ/xcshareddata/xcschemes/Studio.xcscheme" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "2700" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            $(ref $APP_TARGET Studio.app Studio)
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO" parallelizable = "YES">
            $(ref $UNIT_TARGET StudioTests.xctest StudioTests)
         </TestableReference>
         <TestableReference skipped = "NO" parallelizable = "NO">
            $(ref $UI_TARGET StudioUITests.xctest StudioUITests)
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         $(ref $APP_TARGET Studio.app Studio)
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         $(ref $APP_TARGET Studio.app Studio)
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"></ArchiveAction>
</Scheme>
EOF

echo "Wrote $PROJ"
