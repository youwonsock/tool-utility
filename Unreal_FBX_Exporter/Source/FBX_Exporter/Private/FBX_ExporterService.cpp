#include "FBX_ExporterService.h"

#include "AssetExportTask.h"
#include "AssetRegistry/AssetData.h"
#include "Components/StaticMeshComponent.h"
#include "ContentBrowserMenuContexts.h"
#include "DesktopPlatformModule.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Exporters/Exporter.h"
#include "Exporters/FbxExportOption.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "IDesktopPlatform.h"
#include "ImageUtils.h"
#include "Interfaces/IMainFrameModule.h"
#include "IMaterialBakingModule.h"
#include "MaterialBakingStructures.h"
#include "MaterialExpressionIO.h"
#include "MaterialShared.h"
#include "MaterialUtilities.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstance.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Guid.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "MeshDescription.h"
#include "Modules/ModuleManager.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshComponentAdapter.h"
#include "ToolMenus.h"
#include "UObject/Package.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SUniformGridPanel.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SWindow.h"
#include "Widgets/Notifications/SNotificationList.h"
#include "Widgets/Text/STextBlock.h"
#include "Framework/Notifications/NotificationManager.h"

#define LOCTEXT_NAMESPACE "FBX_Exporter"

namespace FBXExporter
{
namespace
{
	constexpr TCHAR ConfigSection[] = TEXT("/Script/FBX_Exporter.FBX_ExporterSettings");
	constexpr TCHAR LegacyHavenConfigSection[] = TEXT("/Script/HavenEditor.HavenStaticMeshTextureExportSettings");
	constexpr TCHAR LegacyAssetImportConfigSection[] = TEXT("/Script/AssetImportProjectEditor.AssetImportProjectStaticMeshTextureExportSettings");
	constexpr TCHAR ConfigLastOutputRoot[] = TEXT("LastOutputRoot");

	FString GetLastOutputRoot()
	{
		FString LastOutputRoot;
		const bool bHasNewValue = GConfig->GetString(ConfigSection, ConfigLastOutputRoot, LastOutputRoot, GEditorPerProjectIni)
			&& !LastOutputRoot.IsEmpty();
		if (!bHasNewValue)
		{
			GConfig->GetString(LegacyHavenConfigSection, ConfigLastOutputRoot, LastOutputRoot, GEditorPerProjectIni);
		}
		if (LastOutputRoot.IsEmpty())
		{
			GConfig->GetString(LegacyAssetImportConfigSection, ConfigLastOutputRoot, LastOutputRoot, GEditorPerProjectIni);
		}
		if (!bHasNewValue && !LastOutputRoot.IsEmpty())
		{
			GConfig->SetString(ConfigSection, ConfigLastOutputRoot, *LastOutputRoot, GEditorPerProjectIni);
			GConfig->Flush(false, GEditorPerProjectIni);
		}
		return LastOutputRoot;
	}

	struct FBakedMaterialData
	{
		TMap<FString, TArray<FColor>> MapPixels;
		TArray<FString> Warnings;
	};

	struct FExportDialogState
	{
		bool bAccepted = false;
		FString OutputRoot;
		int32 BakeResolution = 2048;
		bool bReuseDirectTextures = true;
	};

	struct FBatchExportSummary
	{
		int32 RequestedCount = 0;
		int32 SucceededCount = 0;
		FString OutputRoot;
		TArray<FString> Warnings;
		TArray<FString> Errors;
	};

	FString GetMapFileName(const FString& MaterialName, const FString& MapName)
	{
		return FString::Printf(TEXT("%s_%s.png"), *MakeSafeFileName(MaterialName), *MapName);
	}

	bool SaveImage(const FString& FilePath, const TArray<FColor>& Pixels, const int32 Width, const int32 Height, const bool bSRGB, FString& OutError)
	{
		if (Pixels.Num() != Width * Height || Width <= 0 || Height <= 0)
		{
			OutError = FString::Printf(TEXT("Invalid image data for %s."), *FilePath);
			return false;
		}

		const FImageView ImageView(Pixels.GetData(), Width, Height, bSRGB ? EGammaSpace::sRGB : EGammaSpace::Linear);
		if (!FImageUtils::SaveImageByExtension(*FilePath, ImageView))
		{
			OutError = FString::Printf(TEXT("Failed to save image: %s"), *FilePath);
			return false;
		}

		return true;
	}

	bool ResizePixels(
		const TArray<FColor>& SourcePixels,
		const int32 SourceWidth,
		const int32 SourceHeight,
		const bool bSRGB,
		const int32 TargetWidth,
		const int32 TargetHeight,
		TArray<FColor>& OutPixels)
	{
		if (SourcePixels.Num() == 1)
		{
			OutPixels.Init(SourcePixels[0], TargetWidth * TargetHeight);
			return true;
		}

		if (SourceWidth <= 0 || SourceHeight <= 0 || SourcePixels.Num() != SourceWidth * SourceHeight)
		{
			return false;
		}

		if (SourceWidth == TargetWidth && SourceHeight == TargetHeight)
		{
			OutPixels = SourcePixels;
			return true;
		}

		FImage SourceImage(SourceWidth, SourceHeight, ERawImageFormat::BGRA8, bSRGB ? EGammaSpace::sRGB : EGammaSpace::Linear);
		FMemory::Memcpy(SourceImage.RawData.GetData(), SourcePixels.GetData(), SourcePixels.Num() * sizeof(FColor));

		FImage ResizedImage(TargetWidth, TargetHeight, ERawImageFormat::BGRA8, bSRGB ? EGammaSpace::sRGB : EGammaSpace::Linear);
		SourceImage.ResizeTo(
			ResizedImage,
			TargetWidth,
			TargetHeight,
			ERawImageFormat::BGRA8,
			bSRGB ? EGammaSpace::sRGB : EGammaSpace::Linear);

		const TArrayView64<const FColor> ResizedView = ResizedImage.AsBGRA8();
		OutPixels.Append(ResizedView.GetData(), static_cast<int32>(ResizedView.Num()));
		return true;
	}

	bool LoadTexturePixels(
		UTexture2D* Texture,
		const int32 TargetWidth,
		const int32 TargetHeight,
		const bool bSRGB,
		TArray<FColor>& OutPixels)
	{
		if (!Texture)
		{
			return false;
		}

		FImage SourceImage;
		if (!FImageUtils::GetTexture2DSourceImage(Texture, SourceImage))
		{
			return false;
		}

		FImage ConvertedImage;
		SourceImage.CopyTo(
			ConvertedImage,
			ERawImageFormat::BGRA8,
			bSRGB ? EGammaSpace::sRGB : EGammaSpace::Linear);

		const TArrayView64<const FColor> ConvertedView = ConvertedImage.AsBGRA8();
		TArray<FColor> ConvertedPixels;
		ConvertedPixels.Append(ConvertedView.GetData(), static_cast<int32>(ConvertedView.Num()));
		return ResizePixels(
			ConvertedPixels,
			ConvertedImage.SizeX,
			ConvertedImage.SizeY,
			bSRGB,
			TargetWidth,
			TargetHeight,
			OutPixels);
	}

	bool GetBakedPropertyPixels(
		const FBakeOutput& BakeOutput,
		const EMaterialProperty Property,
		const int32 TargetWidth,
		const int32 TargetHeight,
		const FColor DefaultColor,
		TArray<FColor>& OutPixels)
	{
		const TArray<FColor>* SourcePixels = BakeOutput.PropertyData.Find(Property);
		if (!SourcePixels || SourcePixels->IsEmpty())
		{
			OutPixels.Init(DefaultColor, TargetWidth * TargetHeight);
			return true;
		}

		const FIntPoint* SourceSize = BakeOutput.PropertySizes.Find(Property);
		if (!SourceSize)
		{
			if (SourcePixels->Num() == 1)
			{
				OutPixels.Init((*SourcePixels)[0], TargetWidth * TargetHeight);
				return true;
			}
			return false;
		}

		return ResizePixels(
			*SourcePixels,
			SourceSize->X,
			SourceSize->Y,
			BakeOutput.PropertyIsLinearColor.FindRef(Property) ? false : true,
			TargetWidth,
			TargetHeight,
			OutPixels);
	}

	UTexture2D* FindDirectTexture(UMaterialInterface* Material, const EMaterialProperty Property)
	{
		if (!Material || Material->IsA<UMaterialInstance>())
		{
			return nullptr;
		}

		UMaterial* BaseMaterial = Material->GetMaterial();
		if (!BaseMaterial)
		{
			return nullptr;
		}

		TArray<UMaterialExpression*> Expressions;
		if (!BaseMaterial->GetExpressionsInPropertyChain(Property, Expressions, nullptr) || Expressions.Num() != 1)
		{
			return nullptr;
		}

		UMaterialExpressionTextureSample* TextureSample = Cast<UMaterialExpressionTextureSample>(Expressions[0]);
		if (!TextureSample || TextureSample->TextureObject.Expression || TextureSample->Coordinates.Expression)
		{
			return nullptr;
		}

		return Cast<UTexture2D>(TextureSample->Texture);
	}

	bool ExportFbx(UStaticMesh* StaticMesh, const FString& FilePath, FString& OutError)
	{
		UAssetExportTask* ExportTask = NewObject<UAssetExportTask>(GetTransientPackage());
		ExportTask->Object = StaticMesh;
		ExportTask->Filename = FilePath;
		ExportTask->bSelected = false;
		ExportTask->bReplaceIdentical = true;
		ExportTask->bPrompt = false;
		ExportTask->bAutomated = true;
		ExportTask->bUseFileArchive = false;
		ExportTask->bWriteEmptyFiles = false;

		UFbxExportOption* ExportOptions = NewObject<UFbxExportOption>(ExportTask);
		ExportOptions->bASCII = false;
		ExportOptions->LevelOfDetail = false;
		ExportOptions->Collision = false;
		ExportOptions->bExportSourceMesh = false;
		ExportOptions->VertexColor = true;
		ExportOptions->BakeMaterialInputs = EFbxMaterialBakeMode::Disabled;
		ExportTask->Options = ExportOptions;
		ExportTask->Exporter = UExporter::FindExporter(StaticMesh, TEXT("FBX"));

		if (!ExportTask->Exporter)
		{
			OutError = TEXT("UE could not find the Static Mesh FBX exporter.");
			return false;
		}

		if (!UExporter::RunAssetExportTask(ExportTask))
		{
			OutError = ExportTask->Errors.IsEmpty()
				? TEXT("Static Mesh FBX export failed.")
				: FString::Join(ExportTask->Errors, TEXT("\n"));
			return false;
		}

		return IFileManager::Get().FileExists(*FilePath);
	}

	bool BakeMaterial(
		UStaticMesh* StaticMesh,
		const int32 SlotIndex,
		UMaterialInterface* Material,
		const FFBXExporterOptions& Options,
		FBakedMaterialData& OutMaterialData,
		FString& OutError)
	{
		UStaticMeshComponent* TransientComponent = NewObject<UStaticMeshComponent>(GetTransientPackage());
		TransientComponent->SetStaticMesh(StaticMesh);
		FStaticMeshComponentAdapter Adapter(TransientComponent);

		FMeshDescription MeshDescription;
		FStaticMeshAttributes(MeshDescription).Register();
		Adapter.RetrieveRawMeshData(0, MeshDescription, true);
		if (MeshDescription.GetNumUVElementChannels() <= 0)
		{
			OutError = FString::Printf(TEXT("Material bake requires UV0, but Static Mesh slot %d has no UV channel."), SlotIndex);
			return false;
		}

		TArray<FSectionInfo> Sections;
		Adapter.RetrieveMeshSections(0, Sections);
		TArray<int32> MaterialSectionIndices;
		for (int32 SectionIndex = 0; SectionIndex < Sections.Num(); ++SectionIndex)
		{
			if (Sections[SectionIndex].MaterialIndex == SlotIndex)
			{
				MaterialSectionIndices.Add(SectionIndex);
			}
		}

		if (MaterialSectionIndices.IsEmpty())
		{
			OutMaterialData.Warnings.Add(TEXT("Material slot is not used by LOD0; no textures were generated."));
			return true;
		}

		FMeshData MeshSettings;
		MeshSettings.MeshDescription = &MeshDescription;
		MeshSettings.Mesh = StaticMesh;
		MeshSettings.MaterialIndices = MaterialSectionIndices;
		MeshSettings.TextureCoordinateIndex = 0;
		MeshSettings.TextureCoordinateBox = FBox2D(FVector2D::ZeroVector, FVector2D(1.0f, 1.0f));
		MeshSettings.PrimitiveData = FPrimitiveData(StaticMesh);
		Adapter.ApplySettings(0, MeshSettings);

		FMaterialData MaterialSettings;
		MaterialSettings.Material = Material;
		MaterialSettings.BlendMode = Material->GetBlendMode();
		MaterialSettings.bTangentSpaceNormal = true;
		MaterialSettings.bPerformBorderSmear = true;
		MaterialSettings.bPerformShrinking = false;
		if (Material->WritesToRuntimeVirtualTexture())
		{
			OutMaterialData.Warnings.Add(TEXT("Material writes to a Runtime Virtual Texture; Unity material setup must be handled manually."));
		}
		if (UMaterial* BaseMaterial = Material->GetMaterial())
		{
			if (BaseMaterial->HasSubstrateFrontMaterialConnected())
			{
				OutMaterialData.Warnings.Add(TEXT("Material uses a Substrate front material; only the baked PBR textures are exported."));
			}
			if (BaseMaterial->HasAnyExpressionsInMaterialAndFunctionsOfType<UMaterialExpressionCustom>())
			{
				OutMaterialData.Warnings.Add(TEXT("Material contains Custom HLSL; only the baked PBR textures are exported."));
			}
		}

		const FIntPoint BakeSize(Options.BakeResolution, Options.BakeResolution);
		const EMaterialProperty Properties[] = {
			MP_BaseColor,
			MP_Normal,
			MP_Metallic,
			MP_Roughness,
			MP_AmbientOcclusion,
			MP_EmissiveColor,
			MP_Opacity,
			MP_OpacityMask
		};
		for (const EMaterialProperty Property : Properties)
		{
			MaterialSettings.PropertySizes.Add(Property, BakeSize);
		}

		TArray<FMaterialData*> MaterialSettingsArray;
		MaterialSettingsArray.Add(&MaterialSettings);
		TArray<FMeshData*> MeshSettingsArray;
		MeshSettingsArray.Add(&MeshSettings);
		FBakeOutput BakeOutput;

		IMaterialBakingModule& MaterialBakingModule = FModuleManager::LoadModuleChecked<IMaterialBakingModule>(TEXT("MaterialBaking"));
		MaterialBakingModule.SetEmissiveHDR(false);
		MaterialBakingModule.SetLinearBake(true);
		MaterialBakingModule.BakeMaterials(MaterialSettingsArray, MeshSettingsArray, BakeOutput);

		TMap<EMaterialProperty, UTexture2D*> DirectTextures;
		if (Options.bReuseDirectTextures)
		{
			for (const EMaterialProperty Property : Properties)
			{
				if (UTexture2D* DirectTexture = FindDirectTexture(Material, Property))
				{
					DirectTextures.Add(Property, DirectTexture);
				}
			}
		}
		if (BakeOutput.PropertyData.IsEmpty() && DirectTextures.IsEmpty())
		{
			OutError = FString::Printf(TEXT("Material bake returned no property data for slot %d (%s)."), SlotIndex, *Material->GetName());
			return false;
		}

		auto GetProperty = [&](const EMaterialProperty Property, const FColor DefaultColor, const bool bSRGB, TArray<FColor>& OutPixels)
		{
			if (UTexture2D* DirectTexture = DirectTextures.FindRef(Property))
			{
				if (LoadTexturePixels(DirectTexture, Options.BakeResolution, Options.BakeResolution, bSRGB, OutPixels))
				{
					return true;
				}
				OutMaterialData.Warnings.Add(FString::Printf(
					TEXT("Direct texture could not be read for material property %d; baked output was used."),
					static_cast<int32>(Property)));
			}

			return GetBakedPropertyPixels(
				BakeOutput,
				Property,
				Options.BakeResolution,
				Options.BakeResolution,
				DefaultColor,
				OutPixels);
		};

		TArray<FColor> BaseColor;
		TArray<FColor> Normal;
		TArray<FColor> Emission;
		TArray<FColor> Opacity;
		if (!GetProperty(MP_BaseColor, FColor::White, true, BaseColor) ||
			!GetProperty(MP_Normal, FColor(128, 128, 255, 255), false, Normal) ||
			!GetProperty(MP_EmissiveColor, FColor::Black, true, Emission) ||
			!GetProperty(Material->GetBlendMode() == BLEND_Masked ? MP_OpacityMask : MP_Opacity, FColor::White, false, Opacity))
		{
			OutError = FString::Printf(TEXT("Material bake failed for slot %d (%s)."), SlotIndex, *Material->GetName());
			return false;
		}

		TArray<FColor> Metallic;
		TArray<FColor> AmbientOcclusion;
		TArray<FColor> Roughness;
		if (!GetProperty(MP_Metallic, FColor::Black, false, Metallic) ||
			!GetProperty(MP_AmbientOcclusion, FColor::White, false, AmbientOcclusion) ||
			!GetProperty(MP_Roughness, FColor(128, 128, 128, 255), false, Roughness))
		{
			OutError = FString::Printf(TEXT("Scalar material bake failed for slot %d (%s)."), SlotIndex, *Material->GetName());
			return false;
		}

		// Preserve opacity in BaseColor alpha and also export its standalone map so
		// the manually authored Unity material can choose the desired alpha workflow.
		for (int32 PixelIndex = 0; PixelIndex < BaseColor.Num() && PixelIndex < Opacity.Num(); ++PixelIndex)
		{
			BaseColor[PixelIndex].A = Opacity[PixelIndex].R;
		}

		TArray<FColor> Mask;
		BuildMaskPixels(Metallic, AmbientOcclusion, Roughness, Options.BakeResolution, Options.BakeResolution, Mask);

		auto SaveMap = [&](const FString& MapName, const TArray<FColor>& Pixels)
		{
			OutMaterialData.MapPixels.Add(MapName, Pixels);
		};

		SaveMap(TEXT("BaseColor"), BaseColor);
		SaveMap(TEXT("Normal"), Normal);
		SaveMap(TEXT("Mask"), Mask);
		SaveMap(TEXT("Occlusion"), AmbientOcclusion);
		SaveMap(TEXT("Emission"), Emission);
		SaveMap(Material->GetBlendMode() == BLEND_Masked ? TEXT("OpacityMask") : TEXT("Opacity"), Opacity);

		return true;
	}

	bool RestorePreviousFiles(const FString& BackupDirectory, const FString& FinalDirectory)
	{
		TArray<FString> BackupFiles;
		IFileManager::Get().FindFilesRecursive(BackupFiles, *BackupDirectory, TEXT("*"), true, false);
		bool bSuccess = true;
		for (const FString& BackupFile : BackupFiles)
		{
			FString RelativePath = BackupFile.Mid(BackupDirectory.Len());
			RelativePath.RemoveFromStart(TEXT("/"));
			RelativePath.RemoveFromStart(TEXT("\\"));
			const FString DestinationPath = FinalDirectory / RelativePath;
			bSuccess &= IFileManager::Get().MakeDirectory(*FPaths::GetPath(DestinationPath), true);
			bSuccess &= IFileManager::Get().Move(*DestinationPath, *BackupFile, true, true);
		}
		return bSuccess;
	}

	bool CopyStagedFiles(
		const FString& StagingDirectory,
		const FString& FinalDirectory,
		FString& OutError)
	{
		const FString BackupDirectory = StagingDirectory + TEXT("_Previous");
		auto RestoreAndCleanupBackup = [&BackupDirectory, &FinalDirectory]()
		{
			const bool bRestored = RestorePreviousFiles(BackupDirectory, FinalDirectory);
			if (bRestored)
			{
				IFileManager::Get().DeleteDirectory(*BackupDirectory, false, true);
			}
			return bRestored;
		};
		TArray<FString> StagedFiles;
		IFileManager::Get().FindFilesRecursive(StagedFiles, *StagingDirectory, TEXT("*"), true, false);

		for (const FString& StagedFile : StagedFiles)
		{
			FString RelativePath = StagedFile.Mid(StagingDirectory.Len());
			RelativePath.RemoveFromStart(TEXT("/"));
			RelativePath.RemoveFromStart(TEXT("\\"));
			const FString DestinationPath = FinalDirectory / RelativePath;
			if (IFileManager::Get().FileExists(*DestinationPath))
			{
				const FString BackupPath = BackupDirectory / RelativePath;
				if (!IFileManager::Get().MakeDirectory(*FPaths::GetPath(BackupPath), true) ||
					!IFileManager::Get().Move(*BackupPath, *DestinationPath, true, true))
				{
					RestoreAndCleanupBackup();
					OutError = FString::Printf(TEXT("Failed to stage the existing output file: %s"), *DestinationPath);
					return false;
				}
			}
		}

		TArray<FString> PublishedFiles;
		for (const FString& StagedFile : StagedFiles)
		{
			FString RelativePath = StagedFile.Mid(StagingDirectory.Len());
			RelativePath.RemoveFromStart(TEXT("/"));
			RelativePath.RemoveFromStart(TEXT("\\"));
			const FString DestinationPath = FinalDirectory / RelativePath;
			if (!IFileManager::Get().MakeDirectory(*FPaths::GetPath(DestinationPath), true) ||
				IFileManager::Get().Copy(*DestinationPath, *StagedFile, true, true) != COPY_OK)
			{
				OutError = FString::Printf(TEXT("Failed to publish generated file: %s"), *DestinationPath);
				for (const FString& PublishedFile : PublishedFiles)
				{
					IFileManager::Get().Delete(*PublishedFile, false, true, true);
				}
				RestoreAndCleanupBackup();
				return false;
			}
			PublishedFiles.Add(DestinationPath);
		}

		IFileManager::Get().DeleteDirectory(*BackupDirectory, false, true);
		return true;
	}

	FFBXExporterResult ExportStaticMesh(UStaticMesh* StaticMesh, const FFBXExporterOptions& Options)
	{
		FFBXExporterResult Result;
		if (!StaticMesh)
		{
			Result.Errors.Add(TEXT("No Static Mesh was selected."));
			return Result;
		}
		if (!StaticMesh->HasValidRenderData() || StaticMesh->GetNumLODs() <= 0)
		{
			Result.Errors.Add(FString::Printf(TEXT("Static Mesh has no valid LOD0 render data: %s"), *StaticMesh->GetPathName()));
			return Result;
		}

		if (Options.OutputRoot.IsEmpty())
		{
			Result.Errors.Add(TEXT("Output folder is empty."));
			return Result;
		}

		const FString MeshName = MakeSafeFileName(StaticMesh->GetName());
		const FString FinalDirectory = FPaths::Combine(Options.OutputRoot, MeshName);
		if (IFileManager::Get().DirectoryExists(*FinalDirectory))
		{
			const EAppReturnType::Type OverwriteChoice = FMessageDialog::Open(
				EAppMsgType::YesNo,
				FText::Format(
					LOCTEXT("OverwriteExistingMeshFolder", "The static mesh export folder already exists for {0}. Replace the FBX and matching texture files?"),
					FText::FromString(StaticMesh->GetName())));
			if (OverwriteChoice != EAppReturnType::Yes)
			{
				return Result;
			}
		}

		if (!IFileManager::Get().MakeDirectory(*Options.OutputRoot, true))
		{
			Result.Errors.Add(FString::Printf(TEXT("Failed to create output root: %s"), *Options.OutputRoot));
			return Result;
		}

		const FString StagingDirectory = Options.OutputRoot / (TEXT(".FBX_Exporter_") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
		IFileManager::Get().MakeDirectory(*StagingDirectory, true);
		const auto CleanupStaging = [&StagingDirectory]()
		{
			IFileManager::Get().DeleteDirectory(*StagingDirectory, false, true);
			IFileManager::Get().DeleteDirectory(*(StagingDirectory + TEXT("_Previous")), false, true);
		};

		const FString FbxPath = StagingDirectory / (MeshName + TEXT(".fbx"));
		FString Error;
		if (!ExportFbx(StaticMesh, FbxPath, Error))
		{
			Result.Errors.Add(Error);
			CleanupStaging();
			return Result;
		}

		const TArray<FStaticMaterial>& StaticMaterials = StaticMesh->GetStaticMaterials();
		for (int32 SlotIndex = 0; SlotIndex < StaticMaterials.Num(); ++SlotIndex)
		{
			const FName SlotName = StaticMaterials[SlotIndex].MaterialSlotName.IsNone()
				? FName(*FString::Printf(TEXT("Slot_%d"), SlotIndex))
				: StaticMaterials[SlotIndex].MaterialSlotName;

			UMaterialInterface* Material = StaticMesh->GetMaterial(SlotIndex);
			if (!Material)
			{
				Result.Warnings.Add(FString::Printf(TEXT("Material slot %d has no assigned material; no textures were generated."), SlotIndex));
				continue;
			}

			FBakedMaterialData MaterialData;
			if (!BakeMaterial(StaticMesh, SlotIndex, Material, Options, MaterialData, Error))
			{
				Result.Errors.Add(Error);
				CleanupStaging();
				return Result;
			}

			for (const TPair<FString, TArray<FColor>>& MapPair : MaterialData.MapPixels)
			{
				const bool bSRGB = MapPair.Key == TEXT("BaseColor") || MapPair.Key == TEXT("Emission");
				const FString MaterialName = SlotName.IsNone() ? FString::Printf(TEXT("Slot_%d"), SlotIndex) : SlotName.ToString();
				const FString AbsolutePath = StagingDirectory / TEXT("Textures") / GetMapFileName(MaterialName, MapPair.Key);
				if (!IFileManager::Get().MakeDirectory(*FPaths::GetPath(AbsolutePath), true) ||
					!SaveImage(AbsolutePath, MapPair.Value, Options.BakeResolution, Options.BakeResolution, bSRGB, Error))
				{
					Result.Errors.Add(Error);
					CleanupStaging();
					return Result;
				}
			}

			Result.Warnings.Append(MaterialData.Warnings);
		}

		if (!CopyStagedFiles(StagingDirectory, FinalDirectory, Error))
		{
			Result.Errors.Add(Error);
			CleanupStaging();
			return Result;
		}

		CleanupStaging();
		Result.bSuccess = true;
		Result.FinalDirectory = FinalDirectory;
		return Result;
	}

	void NotifyBatchExportResult(const FBatchExportSummary& Summary)
	{
		if (!Summary.Errors.IsEmpty())
		{
			FString Message = FString::Printf(
				TEXT("Static Mesh texture export finished: %d/%d mesh(es) exported.\n\n%s"),
				Summary.SucceededCount,
				Summary.RequestedCount,
				*FString::Join(Summary.Errors, TEXT("\n")));
			FMessageDialog::Open(
				EAppMsgType::Ok,
				FText::FromString(Message));
			return;
		}

		FNotificationInfo Notification(
			Summary.Warnings.IsEmpty()
				? FText::Format(
					LOCTEXT("StaticMeshTextureExportBatchSucceeded", "Exported {0} Static Mesh(es) to {1}"),
					FText::AsNumber(Summary.SucceededCount),
					FText::FromString(Summary.OutputRoot))
				: FText::Format(
					LOCTEXT("StaticMeshTextureExportBatchWithWarnings", "Exported {0} Static Mesh(es) with {1} warning(s) to {2}"),
					FText::AsNumber(Summary.SucceededCount),
					FText::AsNumber(Summary.Warnings.Num()),
					FText::FromString(Summary.OutputRoot)));
		Notification.ExpireDuration = 6.0f;
		Notification.bFireAndForget = true;
		FSlateNotificationManager::Get().AddNotification(Notification);
	}

	void ExecuteExport(const TArray<FAssetData>& AssetData, const FFBXExporterOptions& Options)
	{
		FBatchExportSummary Summary;
		Summary.RequestedCount = AssetData.Num();
		Summary.OutputRoot = Options.OutputRoot;

		TArray<UStaticMesh*> StaticMeshes;
		TSet<FString> MeshFolderNames;
		for (const FAssetData& Asset : AssetData)
		{
			UStaticMesh* StaticMesh = Cast<UStaticMesh>(Asset.GetAsset());
			if (!StaticMesh || !StaticMesh->IsAsset())
			{
				Summary.Errors.Add(FString::Printf(TEXT("Not a loadable Static Mesh: %s"), *Asset.GetObjectPathString()));
				continue;
			}

			const FString MeshFolderName = MakeSafeFileName(StaticMesh->GetName());
			if (MeshFolderNames.Contains(MeshFolderName))
			{
				Summary.Errors.Add(FString::Printf(
					TEXT("Multiple selected assets resolve to the same output folder '%s'. Rename one asset or export it separately."),
					*MeshFolderName));
				continue;
			}

			MeshFolderNames.Add(MeshFolderName);
			StaticMeshes.Add(StaticMesh);
		}

		if (!Summary.Errors.IsEmpty())
		{
			NotifyBatchExportResult(Summary);
			return;
		}

		GConfig->SetString(ConfigSection, ConfigLastOutputRoot, *Options.OutputRoot, GEditorPerProjectIni);
		GConfig->Flush(false, GEditorPerProjectIni);

		for (UStaticMesh* StaticMesh : StaticMeshes)
		{
			const FFBXExporterResult Result = ExportStaticMesh(StaticMesh, Options);
			if (Result.Succeeded())
			{
				++Summary.SucceededCount;
			}
			else if (!Result.Errors.IsEmpty())
			{
				for (const FString& Error : Result.Errors)
				{
					Summary.Errors.Add(FString::Printf(TEXT("%s: %s"), *StaticMesh->GetName(), *Error));
				}
			}
			else
			{
				Summary.Warnings.Add(FString::Printf(TEXT("%s was skipped."), *StaticMesh->GetName()));
			}

			for (const FString& Warning : Result.Warnings)
			{
				Summary.Warnings.Add(FString::Printf(TEXT("%s: %s"), *StaticMesh->GetName(), *Warning));
			}
		}

		NotifyBatchExportResult(Summary);
	}
}

namespace Testing
{
	FString ReadAndMigrateLastOutputRoot()
	{
		return GetLastOutputRoot();
	}

	bool PublishStagedFiles(const FString& StagingDirectory, const FString& FinalDirectory, FString& OutError)
	{
		return CopyStagedFiles(StagingDirectory, FinalDirectory, OutError);
	}
}

FString MakeSafeFileName(const FString& InName)
{
	FString Result = InName.TrimStartAndEnd();
	const FString InvalidCharacters = TEXT("<>:\"/\\|?*");
	for (int32 Index = 0; Index < Result.Len(); ++Index)
	{
		int32 InvalidCharacterIndex = INDEX_NONE;
		if (InvalidCharacters.FindChar(Result[Index], InvalidCharacterIndex))
		{
			Result[Index] = TEXT('_');
		}
	}
	return Result.IsEmpty() ? TEXT("Unnamed") : Result;
}

void BuildMaskPixels(
	const TArray<FColor>& Metallic,
	const TArray<FColor>& AmbientOcclusion,
	const TArray<FColor>& Roughness,
	const int32 Width,
	const int32 Height,
	TArray<FColor>& OutPixels)
{
	const int32 PixelCount = Width * Height;
	OutPixels.SetNum(PixelCount);

	auto ReadChannel = [](const TArray<FColor>& Pixels, const int32 Index, const uint8 DefaultValue) -> uint8
	{
		if (Pixels.Num() == 1)
		{
			return Pixels[0].R;
		}
		return Pixels.IsValidIndex(Index) ? Pixels[Index].R : DefaultValue;
	};

	for (int32 Index = 0; Index < PixelCount; ++Index)
	{
		const uint8 MetallicValue = ReadChannel(Metallic, Index, 0);
		const uint8 OcclusionValue = ReadChannel(AmbientOcclusion, Index, 255);
		const uint8 RoughnessValue = ReadChannel(Roughness, Index, 128);
		OutPixels[Index] = FColor(MetallicValue, OcclusionValue, 255, 255 - RoughnessValue);
	}
}

void PopulateContentBrowserMenu(UToolMenu* Menu)
{
	if (!Menu)
	{
		return;
	}

	const UContentBrowserAssetContextMenuContext* Context =
		Menu->FindContext<UContentBrowserAssetContextMenuContext>();
	if (!Context || Context->SelectedAssets.IsEmpty())
	{
		return;
	}

	TArray<FAssetData> SelectedAssets;
	SelectedAssets.Reserve(Context->SelectedAssets.Num());
	for (const FAssetData& AssetData : Context->SelectedAssets)
	{
		if (!AssetData.IsInstanceOf(UStaticMesh::StaticClass()) || !Cast<UStaticMesh>(AssetData.GetAsset()))
		{
			return;
		}
		SelectedAssets.Add(AssetData);
	}
	FToolMenuSection& Section = Menu->AddSection(
		TEXT("FBX_Exporter"),
		LOCTEXT("FBXExporterHeading", "FBX_Exporter"));
	Section.AddMenuEntry(
		TEXT("FBX_Exporter.ExportStaticMesh"),
		LOCTEXT("ExportStaticMeshesWithTextures", "Export Static Meshes + Textures"),
		LOCTEXT("ExportStaticMeshesWithTexturesTooltip", "Export all selected Static Meshes as separate FBX files and texture folders."),
		FSlateIcon(),
		FUIAction(FExecuteAction::CreateLambda([SelectedAssets]()
		{
			ShowExportDialog(SelectedAssets);
		})));
}

void ShowExportDialog(const TArray<FAssetData>& SelectedAssets)
{
	if (SelectedAssets.IsEmpty())
	{
		return;
	}

	FString LastOutputRoot = GetLastOutputRoot();
	if (LastOutputRoot.IsEmpty())
	{
		LastOutputRoot = FPaths::ProjectDir() / TEXT("Exports/StaticMeshTextures");
	}

	TSharedRef<FExportDialogState> State = MakeShared<FExportDialogState>();
	State->OutputRoot = LastOutputRoot;

	TArray<TSharedPtr<int32>> ResolutionOptions;
	for (const int32 Resolution : {512, 1024, 2048, 4096})
	{
		ResolutionOptions.Add(MakeShared<int32>(Resolution));
	}
	TSharedPtr<int32> SelectedResolution = ResolutionOptions[2];
	TSharedPtr<SEditableTextBox> OutputTextBox;
	TSharedPtr<STextBlock> ResolutionText;
	TSharedPtr<SWindow> Window;

	SAssignNew(Window, SWindow)
		.Title(LOCTEXT("FBXExporterWindowTitle", "FBX_Exporter"))
		.ClientSize(FVector2D(620.0f, 270.0f))
		.SupportsMaximize(false)
		.SupportsMinimize(false);

	Window->SetContent(
		SNew(SBorder)
		.Padding(16.0f)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 0.0f, 0.0f, 8.0f)
			[
				SNew(STextBlock).Text(FText::Format(
					LOCTEXT("SourceStaticMeshes", "Selected Static Meshes: {0}\nEach mesh is exported to its own folder below the output root."),
					FText::AsNumber(SelectedAssets.Num())))
			]
			+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 0.0f, 0.0f, 8.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().FillWidth(1.0f)
				[
					SAssignNew(OutputTextBox, SEditableTextBox)
					.Text(FText::FromString(State->OutputRoot))
				]
				+ SHorizontalBox::Slot().AutoWidth().Padding(8.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.Text(LOCTEXT("BrowseOutputFolder", "Browse..."))
					.OnClicked_Lambda([OutputTextBox]()
					{
						if (IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get())
						{
							FString SelectedFolder;
							const void* ParentWindowHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
							if (DesktopPlatform->OpenDirectoryDialog(
								ParentWindowHandle,
								LOCTEXT("SelectStaticMeshTextureOutputFolder", "Select Static Mesh Texture Export Folder").ToString(),
								OutputTextBox->GetText().ToString(),
								SelectedFolder))
							{
								OutputTextBox->SetText(FText::FromString(SelectedFolder));
							}
						}
						return FReply::Handled();
					})
				]
			]
			+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 0.0f, 0.0f, 8.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
				[
					SNew(STextBlock).Text(LOCTEXT("BakeResolutionLabel", "PBR Bake Resolution"))
				]
				+ SHorizontalBox::Slot().AutoWidth().Padding(16.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SComboBox<TSharedPtr<int32>>)
					.OptionsSource(&ResolutionOptions)
					.InitiallySelectedItem(SelectedResolution)
					.OnGenerateWidget_Lambda([](TSharedPtr<int32> Value)
					{
						return SNew(STextBlock).Text(FText::AsNumber(Value.IsValid() ? *Value : 2048));
					})
					.OnSelectionChanged_Lambda([State, &SelectedResolution, &ResolutionText](TSharedPtr<int32> Value, ESelectInfo::Type)
					{
						if (Value.IsValid())
						{
							SelectedResolution = Value;
							State->BakeResolution = *Value;
							if (ResolutionText.IsValid())
							{
								ResolutionText->SetText(FText::AsNumber(*Value));
							}
						}
					})
					[
						SAssignNew(ResolutionText, STextBlock).Text(FText::AsNumber(*SelectedResolution))
					]
				]
			]
			+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 0.0f, 0.0f, 4.0f)
			[
				SNew(SCheckBox)
				.IsChecked(ECheckBoxState::Checked)
				.OnCheckStateChanged_Lambda([State](ECheckBoxState NewState)
				{
					State->bReuseDirectTextures = NewState == ECheckBoxState::Checked;
				})
				[
					SNew(STextBlock).Text(LOCTEXT("ReuseDirectTextures", "Reuse directly connected source textures when available"))
				]
			]
			+ SVerticalBox::Slot().FillHeight(1.0f)
			[
				SNew(STextBlock).Text(LOCTEXT(
					"StaticMeshTextureExportDescription",
					"The export creates only an FBX and a Textures folder. Create and assign Unity materials manually. The Unreal asset is not modified."))
			]
			+ SVerticalBox::Slot().AutoHeight()
			[
				SNew(SUniformGridPanel)
				.SlotPadding(FMargin(8.0f, 0.0f))
				+ SUniformGridPanel::Slot(0, 0)
				[
					SNew(SButton)
					.Text(LOCTEXT("CancelStaticMeshTextureExport", "Cancel"))
					.OnClicked_Lambda([Window]()
					{
						Window->RequestDestroyWindow();
						return FReply::Handled();
					})
				]
				+ SUniformGridPanel::Slot(1, 0)
				[
					SNew(SButton)
					.Text(LOCTEXT("RunStaticMeshTextureExport", "Export"))
					.OnClicked_Lambda([Window, State, OutputTextBox]()
					{
						State->OutputRoot = OutputTextBox->GetText().ToString().TrimStartAndEnd();
						if (State->OutputRoot.IsEmpty())
						{
							FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("MissingUnityOutputFolder", "Select an output folder first."));
							return FReply::Handled();
						}
						if (State->BakeResolution <= 0)
						{
							State->BakeResolution = 2048;
						}
						State->bAccepted = true;
						Window->RequestDestroyWindow();
						return FReply::Handled();
					})
				]
			]
		]);

	TSharedPtr<SWindow> ParentWindow;
	if (FModuleManager::Get().IsModuleLoaded(TEXT("MainFrame")))
	{
		ParentWindow = FModuleManager::LoadModuleChecked<IMainFrameModule>(TEXT("MainFrame")).GetParentWindow();
	}
	FSlateApplication::Get().AddModalWindow(Window.ToSharedRef(), ParentWindow, false);
	if (!State->bAccepted)
	{
		return;
	}

	FFBXExporterOptions Options;
	Options.OutputRoot = State->OutputRoot;
	Options.BakeResolution = State->BakeResolution;
	Options.bReuseDirectTextures = State->bReuseDirectTextures;
	ExecuteExport(SelectedAssets, Options);
}
}

#undef LOCTEXT_NAMESPACE
