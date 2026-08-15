#include "FBX_ExporterService.h"

#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FFBXExporterSafeFileNameTest,
	"FBX_Exporter.Editor.StaticMeshTextureExport.SafeFileName",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FFBXExporterSafeFileNameTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("Invalid path characters are replaced"), FBXExporter::MakeSafeFileName(TEXT("Mesh:01/LOD*0")), TEXT("Mesh_01_LOD_0"));
	TestEqual(TEXT("Empty names receive a stable fallback"), FBXExporter::MakeSafeFileName(TEXT("   ")), TEXT("Unnamed"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FFBXExporterMaskPackingTest,
	"FBX_Exporter.Editor.StaticMeshTextureExport.MaskPacking",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FFBXExporterMaskPackingTest::RunTest(const FString& Parameters)
{
	const TArray<FColor> Metallic = {FColor(10, 0, 0, 255)};
	const TArray<FColor> AmbientOcclusion = {FColor(20, 0, 0, 255)};
	const TArray<FColor> Roughness = {FColor(30, 0, 0, 255)};
	TArray<FColor> Mask;

	FBXExporter::BuildMaskPixels(Metallic, AmbientOcclusion, Roughness, 2, 2, Mask);
	TestEqual(TEXT("Mask has requested pixel count"), Mask.Num(), 4);
	for (const FColor& Pixel : Mask)
	{
		TestEqual(TEXT("Metallic is packed in R"), Pixel.R, static_cast<uint8>(10));
		TestEqual(TEXT("Ambient Occlusion is packed in G"), Pixel.G, static_cast<uint8>(20));
		TestEqual(TEXT("Smoothness is inverse roughness in A"), Pixel.A, static_cast<uint8>(225));
	}

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FFBXExporterConfigMigrationTest,
	"FBX_Exporter.Editor.StaticMeshTextureExport.ConfigMigration",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FFBXExporterConfigMigrationTest::RunTest(const FString& Parameters)
{
	const TCHAR* ConfigSection = TEXT("/Script/FBX_Exporter.FBX_ExporterSettings");
	const TCHAR* HavenLegacySection = TEXT("/Script/HavenEditor.HavenStaticMeshTextureExportSettings");
	const TCHAR* AssetImportLegacySection = TEXT("/Script/AssetImportProjectEditor.AssetImportProjectStaticMeshTextureExportSettings");
	const TCHAR* ConfigKey = TEXT("LastOutputRoot");
	const FString IniFile = GEditorPerProjectIni;

	struct FConfigValue
	{
		bool bExists = false;
		FString Value;
	};

	auto ReadValue = [ConfigKey, &IniFile](const TCHAR* Section)
	{
		FConfigValue Result;
		Result.bExists = GConfig->GetString(Section, ConfigKey, Result.Value, IniFile);
		return Result;
	};
	auto RestoreValue = [ConfigKey, &IniFile](const TCHAR* Section, const FConfigValue& Value)
	{
		if (Value.bExists)
		{
			GConfig->SetString(Section, ConfigKey, *Value.Value, IniFile);
		}
		else
		{
			GConfig->RemoveKey(Section, ConfigKey, IniFile);
		}
	};

	const FConfigValue OriginalNew = ReadValue(ConfigSection);
	const FConfigValue OriginalHaven = ReadValue(HavenLegacySection);
	const FConfigValue OriginalAssetImport = ReadValue(AssetImportLegacySection);

	GConfig->RemoveKey(ConfigSection, ConfigKey, IniFile);
	GConfig->SetString(HavenLegacySection, ConfigKey, TEXT("C:/Legacy/Haven"), IniFile);
	GConfig->SetString(AssetImportLegacySection, ConfigKey, TEXT("C:/Legacy/AssetImportProject"), IniFile);
	GConfig->Flush(false, IniFile);

	const FString MigratedPath = FBXExporter::Testing::ReadAndMigrateLastOutputRoot();
	TestEqual(TEXT("Haven legacy section is preferred"), MigratedPath, TEXT("C:/Legacy/Haven"));

	FString NewPath;
	TestTrue(TEXT("Migrated value is written to the new section"), GConfig->GetString(ConfigSection, ConfigKey, NewPath, IniFile));
	TestEqual(TEXT("New section stores the migrated path"), NewPath, TEXT("C:/Legacy/Haven"));

	GConfig->RemoveKey(ConfigSection, ConfigKey, IniFile);
	GConfig->RemoveKey(HavenLegacySection, ConfigKey, IniFile);
	GConfig->SetString(AssetImportLegacySection, ConfigKey, TEXT("C:/Legacy/AssetImportProject"), IniFile);
	GConfig->Flush(false, IniFile);

	const FString AssetImportMigratedPath = FBXExporter::Testing::ReadAndMigrateLastOutputRoot();
	TestEqual(TEXT("AssetImportProject legacy section is used when Haven has no value"), AssetImportMigratedPath, TEXT("C:/Legacy/AssetImportProject"));

	NewPath.Reset();
	TestTrue(TEXT("AssetImportProject value is written to the new section"), GConfig->GetString(ConfigSection, ConfigKey, NewPath, IniFile));
	TestEqual(TEXT("New section stores the AssetImportProject path"), NewPath, TEXT("C:/Legacy/AssetImportProject"));

	RestoreValue(ConfigSection, OriginalNew);
	RestoreValue(HavenLegacySection, OriginalHaven);
	RestoreValue(AssetImportLegacySection, OriginalAssetImport);
	GConfig->Flush(false, IniFile);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FFBXExporterStagingRollbackTest,
	"FBX_Exporter.Editor.StaticMeshTextureExport.StagingRollback",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FFBXExporterStagingRollbackTest::RunTest(const FString& Parameters)
{
	const FString RootDirectory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("FBX_ExporterTests"), FGuid::NewGuid().ToString(EGuidFormats::Digits));
	const FString StagingDirectory = RootDirectory / TEXT("Staging");
	const FString FinalDirectory = RootDirectory / TEXT("Final");
	IFileManager::Get().MakeDirectory(*StagingDirectory, true);
	IFileManager::Get().MakeDirectory(*FinalDirectory, true);

	const FString ExistingFile = FinalDirectory / TEXT("A.txt");
	const FString BlockingDirectory = FinalDirectory / TEXT("B.txt");
	const FString StagedFile = StagingDirectory / TEXT("A.txt");
	const FString StagedFailureFile = StagingDirectory / TEXT("B.txt");
	FFileHelper::SaveStringToFile(TEXT("previous"), *ExistingFile);
	IFileManager::Get().MakeDirectory(*BlockingDirectory, true);
	FFileHelper::SaveStringToFile(TEXT("replacement"), *StagedFile);
	FFileHelper::SaveStringToFile(TEXT("must fail"), *StagedFailureFile);

	FString Error;
	const bool bPublished = FBXExporter::Testing::PublishStagedFiles(StagingDirectory, FinalDirectory, Error);
	TestFalse(TEXT("Publish fails when a staged destination is blocked"), bPublished);

	FString RestoredContents;
	TestTrue(TEXT("The original file is restored after publish failure"), FFileHelper::LoadFileToString(RestoredContents, *ExistingFile));
	TestEqual(TEXT("Restored file keeps the original contents"), RestoredContents, TEXT("previous"));
	TestTrue(TEXT("The blocking destination remains intact"), IFileManager::Get().DirectoryExists(*BlockingDirectory));
	TestFalse(TEXT("The backup directory is cleaned up"), IFileManager::Get().DirectoryExists(*(StagingDirectory + TEXT("_Previous"))));

	IFileManager::Get().DeleteDirectory(*RootDirectory, false, true);
	return true;
}
