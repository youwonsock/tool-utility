#pragma once

#include "AssetRegistry/AssetData.h"
#include "FBX_ExporterTypes.h"

class UToolMenu;

namespace FBXExporter
{
	void PopulateContentBrowserMenu(UToolMenu* Menu);
	void ShowExportDialog(const TArray<FAssetData>& SelectedAssets);

	FString MakeSafeFileName(const FString& InName);
	void BuildMaskPixels(
		const TArray<FColor>& Metallic,
		const TArray<FColor>& AmbientOcclusion,
		const TArray<FColor>& Roughness,
		int32 Width,
		int32 Height,
		TArray<FColor>& OutPixels);

	namespace Testing
	{
		FString ReadAndMigrateLastOutputRoot();
		bool PublishStagedFiles(const FString& StagingDirectory, const FString& FinalDirectory, FString& OutError);
	}
}
