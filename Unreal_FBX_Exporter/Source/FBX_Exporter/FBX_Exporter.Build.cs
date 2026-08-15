using UnrealBuildTool;

public class FBX_Exporter : ModuleRules
{
	public FBX_Exporter(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine"
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"AssetRegistry",
			"AssetTools",
			"ContentBrowser",
			"DesktopPlatform",
			"ImageCore",
			"InputCore",
			"Json",
			"JsonUtilities",
			"MainFrame",
			"MaterialBaking",
			"MaterialUtilities",
			"MeshDescription",
			"MeshMergeUtilities",
			"Slate",
			"SlateCore",
			"StaticMeshDescription",
			"ToolMenus",
			"UnrealEd"
		});
	}
}
